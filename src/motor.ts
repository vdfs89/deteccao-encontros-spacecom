/**
 * Le o dataset em blocos e processa cada timestamp assim que ele termina.
 *
 * Fiz esse arquivo porque o deteccao.ts nao aguenta os datasets grandes: o
 * dataset7 tem 638 MB e o readFileSync em utf8 passa do limite de string do V8.
 * Alem disso, criar um objeto por linha deixava tudo lento. Aqui cada linha
 * vira so numeros em typed arrays que sao reaproveitados.
 *
 * Depende do arquivo estar ordenado por timestamp (os 7 estao). Se nao estiver,
 * da erro em vez de devolver resultado pela metade.
 *
 * O comparar.ts confere que este arquivo e o deteccao.ts dao o mesmo resultado.
 */
import { openSync, readSync, closeSync } from "node:fs";
import {
  RAIO_TERRA_METROS,
  RAIO_ENCONTRO_METROS,
  type Encontro,
  type TipoEncontro,
} from "./deteccao.js";

const PONTO_E_VIRGULA = 59;
const QUEBRA_LINHA = 10;
const RETORNO_CARRO = 13;
const ASPAS = 34;
const ESPACO = 32;
const MENOS = 45;
const PONTO = 46;
const ZERO = 48;
const NOVE = 57;

const POTENCIAS_DE_10 = Array.from({ length: 23 }, (_, k) => 10 ** k);

/**
 * Diferenca maxima de latitude (em radianos) para valer a pena calcular.
 *
 * A distancia entre dois pontos nunca e menor que R * |dLat|, a parte
 * norte-sul dela. Se so isso ja passa de 20 m, nao tem como ser encontro.
 * O 1e-6 e folga para arredondamento.
 */
const LIMITE_DLAT_RAD = (RAIO_ENCONTRO_METROS + 1e-6) / RAIO_TERRA_METROS;

export interface ResultadoMotor {
  encontros: Encontro[];
  linhas: number;
  timestamps: number;
  timestampsVistos?: string[];
}

/**
 * Inicio/fim de cada um dos 7 campos da linha atual. Reaproveitados entre
 * linhas: com 12 milhoes de linhas, alocar arrays/tuplas por linha pesa.
 */
const INICIO = new Int32Array(7);
const FIM = new Int32Array(7);

// Tira espacos, quebras de linha do Windows e as aspas em volta do campo c.
function aparar(buf: Uint8Array, c: number) {
  let inicio = INICIO[c]!;
  let fim = FIM[c]!;
  while (inicio < fim && (buf[inicio] === ESPACO || buf[inicio] === RETORNO_CARRO)) inicio++;
  while (fim > inicio && (buf[fim - 1] === ESPACO || buf[fim - 1] === RETORNO_CARRO)) fim--;
  if (fim - inicio >= 2 && buf[inicio] === ASPAS && buf[fim - 1] === ASPAS) {
    inicio++;
    fim--;
  }
  INICIO[c] = inicio;
  FIM[c] = fim;
}

function texto(buf: Uint8Array, inicio: number, fim: number): string {
  return Buffer.from(buf.buffer, buf.byteOffset + inicio, fim - inicio).toString("latin1");
}

/** Inteiro nao negativo; NaN se houver qualquer caractere fora de 0-9. */
function lerInteiro(buf: Uint8Array, inicio: number, fim: number): number {
  if (inicio >= fim) return NaN;
  let n = 0;
  for (let i = inicio; i < fim; i++) {
    const c = buf[i]!;
    if (c < ZERO || c > NOVE) return NaN;
    n = n * 10 + (c - ZERO);
  }
  return n;
}

/**
 * Le um decimal tipo -25.59386 direto dos bytes.
 *
 * Junto os digitos num inteiro e divido por 10^casas. Da o mesmo double que
 * Number("-25.59386"), porque os dois arredondam o mesmo valor exato (o
 * inteiro e 10^casas sao representados sem erro). Se aparecer algo estranho,
 * tipo expoente, uso o Number() mesmo.
 */
function lerDecimal(buf: Uint8Array, inicio: number, fim: number): number {
  let i = inicio;
  let negativo = false;
  if (buf[i] === MENOS) {
    negativo = true;
    i++;
  }
  let mantissa = 0;
  let casas = 0;
  let viuPonto = false;
  let digitos = 0;
  for (; i < fim; i++) {
    const c = buf[i]!;
    if (c >= ZERO && c <= NOVE) {
      mantissa = mantissa * 10 + (c - ZERO);
      digitos++;
      if (viuPonto) casas++;
    } else if (c === PONTO && !viuPonto) {
      viuPonto = true;
    } else {
      return Number(texto(buf, inicio, fim));
    }
  }
  if (digitos === 0 || digitos > 15 || casas > 22) return Number(texto(buf, inicio, fim));
  const valor = mantissa / POTENCIAS_DE_10[casas]!;
  return negativo ? -valor : valor;
}

// Posicoes do timestamp atual. Os arrays sao reaproveitados de um timestamp
// para o outro.
class Grupo {
  capacidade = 256;
  n = 0;
  id = new Float64Array(this.capacidade);
  faccao = new Int32Array(this.capacidade); // 0 = sem faccao
  lat = new Float64Array(this.capacidade);
  lon = new Float64Array(this.capacidade);
  latRad = new Float64Array(this.capacidade);
  lonRad = new Float64Array(this.capacidade);
  cosLat = new Float64Array(this.capacidade);
  vitima = new Uint8Array(this.capacidade);
  restricoes: (number[] | null)[] = [];
  ordem: number[] = [];

  crescer() {
    this.capacidade *= 2;
    const copiar = <T extends Float64Array | Int32Array | Uint8Array>(a: T, b: T) => {
      b.set(a);
      return b;
    };
    this.id = copiar(this.id, new Float64Array(this.capacidade));
    this.faccao = copiar(this.faccao, new Int32Array(this.capacidade));
    this.lat = copiar(this.lat, new Float64Array(this.capacidade));
    this.lon = copiar(this.lon, new Float64Array(this.capacidade));
    this.latRad = copiar(this.latRad, new Float64Array(this.capacidade));
    this.lonRad = copiar(this.lonRad, new Float64Array(this.capacidade));
    this.cosLat = copiar(this.cosLat, new Float64Array(this.capacidade));
    this.vitima = copiar(this.vitima, new Uint8Array(this.capacidade));
  }
}

class Detector {
  readonly encontros: Encontro[] = [];
  linhas = 0;
  timestamps = 0;

  private grupo = new Grupo();
  private timestampAtual = "";
  private bytesTimestampAtual = new Uint8Array(64);
  private tamanhoTimestampAtual = -1;
  private readonly timestampsVistos = new Set<string>();
  private readonly faccoesTexto = new Map<string, number>();

  /** Processa uma linha buf[inicio, fim) (sem o \n). */
  linha(buf: Uint8Array, inicio: number, fim: number) {
    // Localiza os 7 campos separados por ';'. Campos ausentes ficam vazios.
    INICIO.fill(fim);
    FIM.fill(fim);
    let campo = 0;
    INICIO[0] = inicio;
    for (let i = inicio; i < fim && campo < 6; i++) {
      if (buf[i] === PONTO_E_VIRGULA) {
        FIM[campo] = i;
        campo++;
        INICIO[campo] = i + 1;
      }
    }
    if (campo < 4) return; // linha vazia ou corrompida
    for (let c = 0; c < 7; c++) aparar(buf, c);

    const id = lerInteiro(buf, INICIO[0]!, FIM[0]!);
    if (Number.isNaN(id)) return; // cabecalho (inclusive repetido) ou lixo

    const lat = lerDecimal(buf, INICIO[3]!, FIM[3]!);
    const lon = lerDecimal(buf, INICIO[4]!, FIM[4]!);
    // NaN em coordenada viraria distancia NaN e um encontro perdido em silencio.
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;

    if (!this.mesmoTimestamp(buf, INICIO[2]!, FIM[2]!)) this.trocarTimestamp(buf, INICIO[2]!, FIM[2]!);

    const g = this.grupo;
    if (g.n === g.capacidade) g.crescer();
    const k = g.n++;
    this.linhas++;

    g.id[k] = id;
    g.lat[k] = lat;
    g.lon[k] = lon;
    // Mesmas expressoes de deteccao.ts, para que a distancia saia bit a bit igual.
    const latRad = (lat * Math.PI) / 180;
    g.latRad[k] = latRad;
    g.lonRad[k] = (lon * Math.PI) / 180;
    g.cosLat[k] = Math.cos(latRad);
    g.faccao[k] = this.codigoFaccao(buf, INICIO[1]!, FIM[1]!);
    const c5 = buf[INICIO[5]!];
    g.vitima[k] = FIM[5]! > INICIO[5]! && (c5 === 116 || c5 === 84) ? 1 : 0; // 't' | 'T'
    g.restricoes[k] = FIM[6]! > INICIO[6]! ? lerListaIds(texto(buf, INICIO[6]!, FIM[6]!)) : null;
  }

  listarTimestamps(): string[] {
    return [...this.timestampsVistos];
  }

  /** Fecha o ultimo grupo. Chamar uma vez ao fim do arquivo. */
  finalizar() {
    this.processarGrupo();
  }

  /** 0 = sem faccao; numerica -> valor + 1; texto -> codigo negativo internado. */
  private codigoFaccao(buf: Uint8Array, inicio: number, fim: number): number {
    if (inicio >= fim) return 0;
    const n = lerInteiro(buf, inicio, fim);
    if (!Number.isNaN(n) && n < 2_000_000_000) return n + 1;
    const nome = texto(buf, inicio, fim);
    let codigo = this.faccoesTexto.get(nome);
    if (codigo === undefined) {
      codigo = -(this.faccoesTexto.size + 1);
      this.faccoesTexto.set(nome, codigo);
    }
    return codigo;
  }

  private mesmoTimestamp(buf: Uint8Array, inicio: number, fim: number): boolean {
    const tamanho = fim - inicio;
    if (tamanho !== this.tamanhoTimestampAtual) return false;
    const atual = this.bytesTimestampAtual;
    for (let i = 0; i < tamanho; i++) if (buf[inicio + i] !== atual[i]) return false;
    return true;
  }

  private trocarTimestamp(buf: Uint8Array, inicio: number, fim: number) {
    this.processarGrupo();

    const novo = texto(buf, inicio, fim);
    if (this.timestampsVistos.has(novo)) {
      throw new Error(
        `Arquivo fora de ordem: o timestamp ${novo} reaparece depois de outro. ` +
          "O motor em streaming exige o arquivo agrupado por timestamp; " +
          "use detectarEncontros() de deteccao.ts para esse caso."
      );
    }
    this.timestampsVistos.add(novo);
    this.timestamps++;
    this.timestampAtual = novo;

    const tamanho = fim - inicio;
    if (tamanho > this.bytesTimestampAtual.length) this.bytesTimestampAtual = new Uint8Array(tamanho);
    this.bytesTimestampAtual.set(buf.subarray(inicio, fim));
    this.tamanhoTimestampAtual = tamanho;
  }

  /**
   * Procura encontros dentro do timestamp atual.
   *
   * Ordeno por latitude e comparo cada ponto so com os seguintes, ate a
   * diferenca de latitude passar de LIMITE_DLAT_RAD. Como as pessoas estao
   * espalhadas pelo pais, quase sempre para na primeira comparacao.
   */
  private processarGrupo() {
    const g = this.grupo;
    const n = g.n;
    if (n < 2) {
      g.n = 0;
      return;
    }

    const ordem = g.ordem;
    ordem.length = n;
    for (let i = 0; i < n; i++) ordem[i] = i;
    const latRad = g.latRad;
    // Insertion sort: com 40 a 120 pontos por timestamp e mais rapido que o
    // Array.sort, que tem o custo de chamar uma funcao de comparacao.
    for (let i = 1; i < n; i++) {
      const atual = ordem[i]!;
      const lat = latRad[atual]!;
      let j = i - 1;
      while (j >= 0 && latRad[ordem[j]!]! > lat) {
        ordem[j + 1] = ordem[j]!;
        j--;
      }
      ordem[j + 1] = atual;
    }

    let paresVistos: Set<string> | null = null;

    for (let x = 0; x < n; x++) {
      const a = ordem[x]!;
      const latA = latRad[a]!;
      for (let y = x + 1; y < n; y++) {
        const b = ordem[y]!;
        if (latRad[b]! - latA > LIMITE_DLAT_RAD) break;

        const idA = g.id[a]!;
        const idB = g.id[b]!;
        if (idA === idB) continue;

        // Haversine identico a haversineMetros() de deteccao.ts.
        const sinLat = Math.sin((latRad[b]! - latA) / 2);
        const sinLon = Math.sin((g.lonRad[b]! - g.lonRad[a]!) / 2);
        const h = sinLat * sinLat + g.cosLat[a]! * g.cosLat[b]! * sinLon * sinLon;
        const distancia = 2 * RAIO_TERRA_METROS * Math.asin(Math.min(1, Math.sqrt(h)));
        if (!(distancia < RAIO_ENCONTRO_METROS)) continue;

        // So importa se o arquivo tiver linha duplicada. Chave em texto porque
        // so e montada quando ha encontro, e assim nao colide com ids grandes.
        const menor = idA < idB ? idA : idB;
        const maior = idA < idB ? idB : idA;
        const chave = `${menor}|${maior}`;
        paresVistos ??= new Set<string>();
        if (paresVistos.has(chave)) continue;
        paresVistos.add(chave);

        this.encontros.push({
          tipo: this.tipo(a, b),
          monitoradosEncontro: [menor, maior],
          timestamp: this.timestampAtual,
          posicoes: {
            [String(idA)]: { lat: g.lat[a]!, lon: g.lon[a]! },
            [String(idB)]: { lat: g.lat[b]!, lon: g.lon[b]! },
          },
          distanciaMetros: distancia,
        });
      }
    }

    g.n = 0;
  }

  /** Mesma regra de tiposDoPar() em modo "prioridade": protetiva > faccao > generico. */
  private tipo(a: number, b: number): TipoEncontro {
    const g = this.grupo;
    const protetiva =
      (g.vitima[a] === 1 && g.restricoes[a]?.includes(g.id[b]!) === true) ||
      (g.vitima[b] === 1 && g.restricoes[b]?.includes(g.id[a]!) === true);
    if (protetiva) return "protetiva";
    if (g.faccao[a] !== 0 && g.faccao[a] === g.faccao[b]) return "faccao";
    return "generico";
  }
}

function lerListaIds(valor: string): number[] {
  const ids: number[] = [];
  for (const parte of valor.split(",")) {
    const t = parte.trim().replace(/^"|"$/g, "");
    if (t === "") continue;
    const n = Number(t);
    if (Number.isFinite(n)) ids.push(n);
  }
  return ids;
}

/** Processa um conteudo ja em memoria (usado pelos testes). */
export function processarBytes(dados: Uint8Array): ResultadoMotor {
  const detector = new Detector();
  let inicio = 0;
  for (let i = 0; i < dados.length; i++) {
    if (dados[i] === QUEBRA_LINHA) {
      detector.linha(dados, inicio, i);
      inicio = i + 1;
    }
  }
  if (inicio < dados.length) detector.linha(dados, inicio, dados.length);
  detector.finalizar();
  return { encontros: detector.encontros, linhas: detector.linhas, timestamps: detector.timestamps };
}

/** Trecho [inicio, fim) do arquivo, em bytes. Deve comecar no inicio de uma linha. */
export interface Faixa {
  inicio: number;
  fim: number;
}

/**
 * Processa um arquivo de qualquer tamanho com memoria constante: le blocos de
 * 8 MB e carrega a linha incompleta do fim de um bloco para o inicio do proximo.
 *
 * Com `faixa`, processa so aquele trecho (e o que cada worker do paralelo.ts faz).
 * Com `listarTimestamps`, devolve os timestamps vistos, para o paralelo.ts
 * conferir que nenhum timestamp ficou dividido entre dois trechos.
 */
export function processarArquivo(
  caminho: string,
  faixa?: Faixa,
  listarTimestamps = false,
  tamanhoBloco = 8 * 1024 * 1024
): ResultadoMotor {
  const detector = new Detector();
  let buf = Buffer.allocUnsafe(tamanhoBloco);
  let pendente = 0; // bytes de linha incompleta no inicio de buf
  const fd = openSync(caminho, "r");
  let posicao = faixa?.inicio ?? 0;
  const fimFaixa = faixa?.fim ?? Infinity;
  try {
    for (;;) {
      if (pendente === buf.length) {
        // Linha maior que o bloco inteiro: dobra o buffer.
        const maior = Buffer.allocUnsafe(buf.length * 2);
        buf.copy(maior, 0, 0, pendente);
        buf = maior;
      }
      const quero = Math.min(buf.length - pendente, fimFaixa - posicao);
      const lidos = quero > 0 ? readSync(fd, buf, pendente, quero, posicao) : 0;
      posicao += lidos;
      const total = pendente + lidos;
      if (lidos === 0) {
        if (total > 0) detector.linha(buf, 0, total);
        break;
      }
      let inicio = 0;
      for (let i = pendente; i < total; i++) {
        if (buf[i] === QUEBRA_LINHA) {
          detector.linha(buf, inicio, i);
          inicio = i + 1;
        }
      }
      pendente = total - inicio;
      buf.copy(buf, 0, inicio, total);
    }
  } finally {
    closeSync(fd);
  }
  detector.finalizar();
  return {
    encontros: detector.encontros,
    linhas: detector.linhas,
    timestamps: detector.timestamps,
    ...(listarTimestamps ? { timestampsVistos: detector.listarTimestamps() } : {}),
  };
}
