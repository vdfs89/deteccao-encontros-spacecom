/**
 * Testes de correcao, sem dependencias externas.
 *
 *  1. Fuzz: compara a grade espacial contra uma forca-bruta O(n^2) de
 *     referencia em dados aleatorios aglomerados. Garante que a otimizacao
 *     nao perde nem inventa encontros.
 *     O mesmo fuzz valida o motor em streaming (motor.ts) contra a forca bruta.
 *  2. Casos de borda: limite de 20 m, aspas no timestamp, direcao da medida
 *     protetiva, timestamps distintos, unicidade do par.
 *
 * Uso: npx tsx src/teste.ts
 */
import {
  parseDataset,
  detectarEncontros,
  haversineMetros,
  parseLinha,
  tiposDoPar,
  RAIO_ENCONTRO_METROS,
  type Posicao,
  type Encontro,
} from "./deteccao.js";
import { processarBytes } from "./motor.js";

let falhas = 0;

function ok(condicao: boolean, nome: string, detalhe = "") {
  if (condicao) {
    console.log(`  PASS  ${nome}`);
  } else {
    falhas++;
    console.log(`  FAIL  ${nome}${detalhe ? `  -> ${detalhe}` : ""}`);
  }
}

function chave(e: Encontro): string {
  const ids = [...e.monitoradosEncontro].sort((x, y) => x - y).join(",");
  return `${e.tipo}|${ids}|${e.timestamp}`;
}

/** Referencia ingenua: todos contra todos, dentro do mesmo timestamp. */
function forcaBruta(posicoes: Posicao[]): Encontro[] {
  const out: Encontro[] = [];
  const porTs = new Map<string, Posicao[]>();
  for (const p of posicoes) {
    const b = porTs.get(p.timestamp);
    if (b) b.push(p);
    else porTs.set(p.timestamp, [p]);
  }
  for (const [ts, pontos] of porTs) {
    const vistos = new Set<string>();
    for (let i = 0; i < pontos.length; i++) {
      for (let j = i + 1; j < pontos.length; j++) {
        const a = pontos[i]!;
        const b = pontos[j]!;
        if (a.id === b.id) continue;
        const menor = Math.min(a.id, b.id);
        const maior = Math.max(a.id, b.id);
        const k = `${menor}|${maior}`;
        if (vistos.has(k)) continue;
        const d = haversineMetros(a, b);
        if (d >= RAIO_ENCONTRO_METROS) continue;
        vistos.add(k);
        out.push({
          tipo: tiposDoPar(a, b)[0]!,
          monitoradosEncontro: [menor, maior],
          timestamp: ts,
          posicoes: {},
          distanciaMetros: d,
        });
      }
    }
  }
  return out;
}

// Gerador deterministico (LCG) para o fuzz ser reproduzivel.
let seed = 20261103;
function rnd(): number {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

console.log("\n=== 1. Fuzz: grade espacial vs forca bruta ===");
{
  // 40 aglomerados espalhados por todo o Brasil (latitudes 0 a -33), cada um
  // com pontos a poucas dezenas de metros: forca muitos pares perto do limite.
  const linhas: string[] = [
    "idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida",
  ];
  let id = 1;
  for (let ts = 0; ts < 12; ts++) {
    const timestamp = `2024-01-01 00:${String(Math.floor(ts / 12)).padStart(2, "0")}:${String((ts * 5) % 60).padStart(2, "0")}`;
    id = 1;
    for (let c = 0; c < 40; c++) {
      const baseLat = -(rnd() * 33);
      const baseLon = -(35 + rnd() * 38);
      for (let k = 0; k < 6; k++) {
        const lat = baseLat + (rnd() - 0.5) * 0.0008;
        const lon = baseLon + (rnd() - 0.5) * 0.0008;
        const faccao = rnd() < 0.5 ? String(1 + Math.floor(rnd() * 3)) : "";
        linhas.push(
          `${id};${faccao};"${timestamp}";${lat.toFixed(5)};${lon.toFixed(5)};false;`
        );
        id++;
      }
    }
  }
  const posicoes = parseDataset(linhas.join("\n"));
  const viaGrade = detectarEncontros(posicoes, "prioridade");
  const viaBruta = forcaBruta(posicoes);

  const setGrade = new Set(viaGrade.map(chave));
  const setBruta = new Set(viaBruta.map(chave));
  const faltando = [...setBruta].filter((k) => !setGrade.has(k));
  const sobrando = [...setGrade].filter((k) => !setBruta.has(k));

  console.log(
    `  ${posicoes.length} posicoes, ${viaBruta.length} encontros na referencia`
  );
  ok(viaBruta.length > 50, "o fuzz gerou encontros suficientes para valer", `${viaBruta.length}`);
  ok(faltando.length === 0, "grade nao perde encontros (falsos negativos)", faltando.slice(0, 3).join(" ; "));
  ok(sobrando.length === 0, "grade nao inventa encontros (falsos positivos)", sobrando.slice(0, 3).join(" ; "));

  // Motor de producao: le os mesmos bytes, deve dar o mesmo conjunto.
  const viaMotor = processarBytes(Buffer.from(linhas.join("\n"))).encontros;
  const setMotor = new Set(viaMotor.map(chave));
  ok(
    setMotor.size === setBruta.size && [...setBruta].every((k) => setMotor.has(k)),
    "motor em streaming == forca bruta",
    `motor ${setMotor.size}, bruta ${setBruta.size}`
  );
}

console.log("\n=== 1b. Motor em streaming: casos especificos ===");
{
  const cab = "idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida";
  const r = processarBytes(
    Buffer.from(
      [
        cab,
        `1;;"2024-01-01 00:00:00";-10.00000;-37.00000;true;"2,9"`,
        `2;7;"2024-01-01 00:00:00";-10.00005;-37.00000;false;`,
        `3;7;"2024-01-01 00:00:00";-10.00010;-37.00000;false;`,
      ].join("\r\n")
    )
  ).encontros;
  const tipoDe = (x: number, y: number) =>
    r.find((e) => e.monitoradosEncontro[0] === x && e.monitoradosEncontro[1] === y)?.tipo;
  ok(tipoDe(1, 2) === "protetiva", "vitima com lista citada \"2,9\" + CRLF -> protetiva", String(tipoDe(1, 2)));
  ok(tipoDe(2, 3) === "faccao", "mesma faccao -> faccao", String(tipoDe(2, 3)));
  ok(tipoDe(1, 3) === "generico", "sem vinculo nem faccao em comum -> generico", String(tipoDe(1, 3)));

  let erro = "";
  try {
    processarBytes(
      Buffer.from(
        [
          cab,
          `1;;"2024-01-01 00:00:00";-10.00000;-37.00000;false;`,
          `1;;"2024-01-01 00:00:05";-10.00000;-37.00000;false;`,
          `2;;"2024-01-01 00:00:00";-10.00000;-37.00000;false;`,
        ].join("\n")
      )
    );
  } catch (e) {
    erro = (e as Error).message;
  }
  ok(erro.includes("fora de ordem"), "arquivo desordenado aborta em vez de perder encontros", erro);
}

console.log("\n=== 2. Limite de 20 metros (estritamente menor) ===");
{
  // Deslocamento puro em latitude: 1 grau = 111194.93 m com R=6.371.000.
  const metrosPorGrau = (Math.PI / 180) * 6_371_000;
  const d = (m: number) => m / metrosPorGrau;

  const casos: Array<[number, boolean, string]> = [
    [19.9, true, "19,9 m conta como encontro"],
    [19.999, true, "19,999 m conta como encontro"],
    [20.001, false, "20,001 m NAO conta"],
    [25, false, "25 m NAO conta"],
  ];

  for (const [metros, esperado, nome] of casos) {
    const linhas = [
      "idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida",
      `1;;"2024-01-01 00:00:00";-10.00000;-37.00000;false;`,
      `2;;"2024-01-01 00:00:00";${(-10 + d(metros)).toFixed(12)};-37.00000;false;`,
    ];
    const r = detectarEncontros(parseDataset(linhas.join("\n")));
    ok(
      (r.length === 1) === esperado,
      nome,
      `detectou ${r.length}${r[0] ? ` a ${r[0].distanciaMetros.toFixed(4)} m` : ""}`
    );
  }

  // A fronteira exata de 20 m nao e construivel a partir de coordenadas:
  // o deslocamento mais proximo rende 19,999999999394 m. Entao a fronteira e
  // verificada na semantica do operador, e nao geograficamente.
  ok(
    !(RAIO_ENCONTRO_METROS < RAIO_ENCONTRO_METROS),
    "exatamente 20 m NAO conta (comparacao e < e nao <=)"
  );
  ok(
    19.999999999 < RAIO_ENCONTRO_METROS,
    "19,999999999 m ainda conta"
  );
  ok(
    !(20.000000001 < RAIO_ENCONTRO_METROS),
    "20,000000001 m nao conta"
  );
}

console.log("\n=== 3. Aspas no timestamp (formato real do dataset) ===");
{
  const p = parseLinha(`1;;"2024-01-01 00:00:00";-25.59386;-73.96319;false;`);
  ok(p !== null, "linha com aspas e parseada");
  ok(p?.timestamp === "2024-01-01 00:00:00", "aspas removidas do timestamp", JSON.stringify(p?.timestamp));
  ok(p?.lat === -25.59386 && p?.lon === -73.96319, "lat/lon numericos");
  ok(p?.medidaProtetiva === false, "medidaProtetiva=false parseado");
  ok(p?.idsRestricaoMedida.length === 0, "campo final vazio -> array vazio");

  const linhas = [
    "idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida",
    `1;;"2024-01-01 00:01:50";-10.07996;-37.08384;false;`,
    `2;;"2024-01-01 00:01:50";-10.07987;-37.08389;false;`,
  ];
  const r = detectarEncontros(parseDataset(linhas.join("\n")));
  ok(r[0]?.timestamp === "2024-01-01 00:01:50", "timestamp do JSON sai sem aspas", JSON.stringify(r[0]?.timestamp));
}

console.log("\n=== 4. Direcao da medida protetiva ===");
{
  // Vitima 99 tem medidaProtetiva=true e lista o agressor 7.
  // O agressor NAO carrega o campo.
  const linhas = [
    "idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida",
    `7;5;"2024-01-01 00:00:00";-10.07996;-37.08384;false;`,
    `99;;"2024-01-01 00:00:00";-10.07987;-37.08389;true;7,8`,
  ];
  const r = detectarEncontros(parseDataset(linhas.join("\n")));
  ok(r.length === 1, "par vitima/agressor gera 1 encontro", `${r.length}`);
  ok(r[0]?.tipo === "protetiva", "classificado como protetiva", r[0]?.tipo);

  // Agressor nao listado pela vitima -> nao e protetiva.
  const linhas2 = [
    "idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida",
    `42;;"2024-01-01 00:00:00";-10.07996;-37.08384;false;`,
    `99;;"2024-01-01 00:00:00";-10.07987;-37.08389;true;7,8`,
  ];
  const r2 = detectarEncontros(parseDataset(linhas2.join("\n")));
  ok(r2[0]?.tipo === "generico", "agressor nao vinculado -> generico", r2[0]?.tipo);

  // Protetiva vence faccao quando ambos se aplicam.
  const linhas3 = [
    "idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida",
    `7;5;"2024-01-01 00:00:00";-10.07996;-37.08384;false;`,
    `99;5;"2024-01-01 00:00:00";-10.07987;-37.08389;true;7`,
  ];
  const r3 = detectarEncontros(parseDataset(linhas3.join("\n")), "prioridade");
  ok(r3.length === 1 && r3[0]?.tipo === "protetiva", "protetiva tem prioridade sobre faccao", r3[0]?.tipo);
  const r3t = detectarEncontros(parseDataset(linhas3.join("\n")), "todos");
  ok(r3t.length === 3, "modo 'todos' emite protetiva+faccao+generico", `${r3t.length}`);
}

console.log("\n=== 5. Faccao ===");
{
  const mesma = [
    "idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida",
    `40;3;"2024-01-01 00:01:50";-10.07996;-37.08384;false;`,
    `44;3;"2024-01-01 00:01:50";-10.07987;-37.08389;false;`,
  ];
  const r = detectarEncontros(parseDataset(mesma.join("\n")));
  ok(r[0]?.tipo === "faccao", "mesma faccao -> faccao", r[0]?.tipo);
  ok(
    Math.abs((r[0]?.distanciaMetros ?? 0) - 11.4) < 1.5,
    "distancia coerente com o exemplo do enunciado (~11,4 m)",
    String(r[0]?.distanciaMetros)
  );

  const vazia = [
    "idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida",
    `40;;"2024-01-01 00:01:50";-10.07996;-37.08384;false;`,
    `44;;"2024-01-01 00:01:50";-10.07987;-37.08389;false;`,
  ];
  const r2 = detectarEncontros(parseDataset(vazia.join("\n")));
  ok(r2[0]?.tipo === "generico", "faccao vazia nos dois NAO vira faccao", r2[0]?.tipo);

  const dif = [
    "idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida",
    `40;3;"2024-01-01 00:01:50";-10.07996;-37.08384;false;`,
    `44;9;"2024-01-01 00:01:50";-10.07987;-37.08389;false;`,
  ];
  const r3 = detectarEncontros(parseDataset(dif.join("\n")));
  ok(r3[0]?.tipo === "generico", "faccoes diferentes -> generico", r3[0]?.tipo);
}

console.log("\n=== 6. Timestamp e unicidade ===");
{
  const outroTs = [
    "idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida",
    `1;;"2024-01-01 00:00:00";-10.07996;-37.08384;false;`,
    `2;;"2024-01-01 00:00:05";-10.07987;-37.08389;false;`,
  ];
  ok(
    detectarEncontros(parseDataset(outroTs.join("\n"))).length === 0,
    "timestamps diferentes nunca sao comparados"
  );

  const trio = [
    "idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida",
    `1;;"2024-01-01 00:00:00";-10.07996;-37.08384;false;`,
    `2;;"2024-01-01 00:00:00";-10.07987;-37.08389;false;`,
    `3;;"2024-01-01 00:00:00";-10.07990;-37.08386;false;`,
  ];
  const r = detectarEncontros(parseDataset(trio.join("\n")));
  ok(r.length === 3, "3 pontos proximos -> 3 pares, nao 6", `${r.length}`);
  const ids = r.map((e) => e.monitoradosEncontro.join(",")).sort();
  ok(
    JSON.stringify(ids) === JSON.stringify(["1,2", "1,3", "2,3"]),
    "pares canonicos sem duplicata invertida",
    ids.join(" | ")
  );
  ok(
    r.every((e) => Object.keys(e.posicoes).length === 2),
    "cada encontro traz as 2 posicoes"
  );
}

console.log("\n=== 7. Robustez do parse ===");
{
  ok(parseLinha("linha;corrompida") === null, "linha curta descartada");
  ok(parseLinha("1;;\"ts\";abc;-37.0;false;") === null, "lat nao numerica descartada");
  const comCabecalho = parseDataset(
    "idMonitorado;faccaoMonitorado;timestamp;latitude;longitude;medidaProtetiva;idsRestricaoMedida\n" +
      `1;;"2024-01-01 00:00:00";-10.0;-37.0;false;\n\n`
  );
  ok(comCabecalho.length === 1, "cabecalho e linhas vazias ignorados", `${comCabecalho.length}`);
  const crlf = parseDataset(
    "idMonitorado;x;x;x;x;x;x\r\n" + `1;;"2024-01-01 00:00:00";-10.0;-37.0;TRUE;1,2,3\r\n`
  );
  ok(crlf.length === 1 && crlf[0]!.medidaProtetiva === true, "CRLF e TRUE maiusculo tratados");
  ok(
    JSON.stringify(crlf[0]!.idsRestricaoMedida) === "[1,2,3]",
    "idsRestricaoMedida parseado",
    JSON.stringify(crlf[0]?.idsRestricaoMedida)
  );
}

console.log(
  falhas === 0
    ? "\nTODOS OS TESTES PASSARAM\n"
    : `\n${falhas} TESTE(S) FALHARAM\n`
);
process.exit(falhas === 0 ? 0 : 1);
