/**
 * Nucleo da deteccao de encontros.
 *
 * Decisoes de projeto documentadas em README.md (secao "Estrategia").
 */

export const RAIO_TERRA_METROS = 6_371_000;
export const RAIO_ENCONTRO_METROS = 20;

/** Metros por grau de latitude (constante: meridianos nao variam com a longitude). */
const METROS_POR_GRAU_LAT = (Math.PI / 180) * RAIO_TERRA_METROS;

export type TipoEncontro = "generico" | "faccao" | "protetiva";

/** Como classificar um par que satisfaz mais de um tipo de encontro. */
export type ModoClassificacao = "prioridade" | "todos";

export interface Posicao {
  id: number;
  faccao: string;
  timestamp: string;
  lat: number;
  lon: number;
  medidaProtetiva: boolean;
  idsRestricaoMedida: number[];
  /** Radianos pre-calculados: evita refazer trigonometria a cada comparacao. */
  latRad: number;
  lonRad: number;
}

export interface Encontro {
  tipo: TipoEncontro;
  monitoradosEncontro: number[];
  timestamp: string;
  posicoes: Record<string, { lat: number; lon: number }>;
  distanciaMetros: number;
}

/**
 * Remove espacos e um par de aspas duplas envolvente.
 *
 * Necessario porque os datasets entregam o timestamp citado:
 *   1;;"2024-01-01 00:00:00";-25.59386;-73.96319;false;
 * Sem isso, o timestamp do JSON de saida sai com aspas literais e nenhum
 * encontro casa com o gabarito.
 */
function limparCampo(valor: string | undefined): string {
  if (valor === undefined) return "";
  const texto = valor.trim();
  if (texto.length >= 2 && texto.startsWith('"') && texto.endsWith('"')) {
    return texto.slice(1, -1).trim();
  }
  return texto;
}

function parseIds(valor: string): number[] {
  if (valor === "") return [];
  const ids: number[] = [];
  for (const parte of valor.split(",")) {
    const n = Number(parte.trim());
    if (Number.isFinite(n)) ids.push(n);
  }
  return ids;
}

export function parseLinha(linha: string): Posicao | null {
  const campos = linha.split(";");
  if (campos.length < 5) return null;

  const id = Number(limparCampo(campos[0]));
  const lat = Number(limparCampo(campos[3]));
  const lon = Number(limparCampo(campos[4]));

  // Linha corrompida ou cabecalho repetido: descartar em vez de gerar NaN,
  // que viraria distancia NaN e um falso positivo silencioso.
  if (!Number.isFinite(id) || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return null;
  }

  return {
    id,
    faccao: limparCampo(campos[1]),
    timestamp: limparCampo(campos[2]),
    lat,
    lon,
    medidaProtetiva: limparCampo(campos[5]).toLowerCase() === "true",
    idsRestricaoMedida: parseIds(limparCampo(campos[6])),
    latRad: (lat * Math.PI) / 180,
    lonRad: (lon * Math.PI) / 180,
  };
}

export function parseDataset(conteudo: string): Posicao[] {
  const posicoes: Posicao[] = [];
  // split manual evita alocar um array intermediario gigante com .map().filter()
  for (const linha of conteudo.split("\n")) {
    const limpa = linha.trim();
    if (limpa === "" || limpa.startsWith("idMonitorado")) continue;
    const p = parseLinha(limpa);
    if (p !== null) posicoes.push(p);
  }
  return posicoes;
}

/** Haversine, consumindo radianos ja calculados no parse. */
export function haversineMetros(a: Posicao, b: Posicao): number {
  const dLat = b.latRad - a.latRad;
  const dLon = b.lonRad - a.lonRad;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h =
    sinLat * sinLat +
    Math.cos(a.latRad) * Math.cos(b.latRad) * sinLon * sinLon;
  return 2 * RAIO_TERRA_METROS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Tipos satisfeitos por um par, em ordem de especificidade.
 *
 * protetiva: quem carrega medidaProtetiva=true e a VITIMA, e e ela que lista os
 * agressores em idsRestricaoMedida. O agressor tem o campo vazio. Portanto a
 * checagem correta e "a e vitima E a lista b", nunca o inverso.
 */
export function tiposDoPar(a: Posicao, b: Posicao): TipoEncontro[] {
  const tipos: TipoEncontro[] = [];

  const protetiva =
    (a.medidaProtetiva && a.idsRestricaoMedida.includes(b.id)) ||
    (b.medidaProtetiva && b.idsRestricaoMedida.includes(a.id));
  if (protetiva) tipos.push("protetiva");

  if (a.faccao !== "" && a.faccao === b.faccao) tipos.push("faccao");

  tipos.push("generico");
  return tipos;
}

interface Celula {
  pontos: Posicao[];
}

/**
 * Detecta encontros em um dataset.
 *
 * @param modo "prioridade" emite 1 encontro por par (o tipo mais especifico);
 *             "todos" emite um encontro por tipo satisfeito.
 *             Use src/validar.ts contra o gabarito para decidir.
 */
export function detectarEncontros(
  posicoes: Posicao[],
  modo: ModoClassificacao = "prioridade"
): Encontro[] {
  const encontros: Encontro[] = [];
  if (posicoes.length === 0) return encontros;

  // 1) Agrupar por timestamp exato: so posicoes simultaneas sao comparaveis.
  const porTimestamp = new Map<string, Posicao[]>();
  let maxAbsLat = 0;
  for (const p of posicoes) {
    const bucket = porTimestamp.get(p.timestamp);
    if (bucket) bucket.push(p);
    else porTimestamp.set(p.timestamp, [p]);
    const abs = Math.abs(p.lat);
    if (abs > maxAbsLat) maxAbsLat = abs;
  }

  // 2) Dimensionar a grade UMA vez para todo o dataset.
  //
  // A celula precisa medir >= 20 m nos dois eixos em QUALQUER ponto do dataset,
  // senao um vizinho a 19 m pode cair a 2 celulas de distancia e ser perdido.
  // Em longitude, metros por grau encolhe com cos(lat); usar a maior latitude
  // absoluta do dataset garante o pior caso. Dimensionar por ponto (com o
  // cos da latitude local) produz chaves inconsistentes entre pontos vizinhos
  // e gera falsos negativos nas bordas das celulas.
  const grauLat = RAIO_ENCONTRO_METROS / METROS_POR_GRAU_LAT;
  const cosMin = Math.max(Math.cos((maxAbsLat * Math.PI) / 180), 1e-6);
  const grauLon = RAIO_ENCONTRO_METROS / (METROS_POR_GRAU_LAT * cosMin);

  const grade = new Map<number, Celula>();
  // Chave numerica (cheia em 32 bits) em vez de string: Map<number> evita
  // alocar uma string por ponto e por consulta de vizinho.
  const chave = (cl: number, cn: number) => cl * 4_294_967_296 + cn;

  for (const [timestamp, pontos] of porTimestamp) {
    grade.clear();

    const celulaLat = new Int32Array(pontos.length);
    const celulaLon = new Int32Array(pontos.length);

    for (let i = 0; i < pontos.length; i++) {
      const p = pontos[i]!;
      const cl = Math.floor(p.lat / grauLat);
      const cn = Math.floor(p.lon / grauLon);
      celulaLat[i] = cl;
      celulaLon[i] = cn;
      const k = chave(cl, cn);
      const celula = grade.get(k);
      if (celula) celula.pontos.push(p);
      else grade.set(k, { pontos: [p] });
    }

    // Unicidade: um par (menorId, maiorId) e registrado no maximo uma vez
    // neste timestamp, independentemente da ordem em que aparece.
    const paresVistos = new Set<string>();

    for (let i = 0; i < pontos.length; i++) {
      const a = pontos[i]!;
      const cl = celulaLat[i]!;
      const cn = celulaLon[i]!;

      for (let dLat = -1; dLat <= 1; dLat++) {
        for (let dLon = -1; dLon <= 1; dLon++) {
          const celula = grade.get(chave(cl + dLat, cn + dLon));
          if (!celula) continue;

          for (const b of celula.pontos) {
            if (a.id === b.id) continue;

            const menor = a.id < b.id ? a.id : b.id;
            const maior = a.id < b.id ? b.id : a.id;
            const parKey = `${menor}|${maior}`;
            if (paresVistos.has(parKey)) continue;

            const distancia = haversineMetros(a, b);
            if (distancia >= RAIO_ENCONTRO_METROS) continue;

            paresVistos.add(parKey);

            const tipos = tiposDoPar(a, b);
            const emitir = modo === "prioridade" ? [tipos[0]!] : tipos;

            for (const tipo of emitir) {
              encontros.push({
                tipo,
                monitoradosEncontro: [menor, maior],
                timestamp,
                posicoes: {
                  [String(a.id)]: { lat: a.lat, lon: a.lon },
                  [String(b.id)]: { lat: b.lat, lon: b.lon },
                },
                distanciaMetros: distancia,
              });
            }
          }
        }
      }
    }
  }

  return encontros;
}
