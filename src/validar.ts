/**
 * Validador contra o gabarito (respostas1.json / respostas2.json).
 *
 * Compara de forma insensivel a ordem e tolerante a ponto flutuante, roda os
 * dois modos de classificacao e diz qual reproduz o gabarito.
 *
 * Uso:
 *   npx tsx src/validar.ts datasets/dataset1.txt gabarito/respostas1.json
 *   npm run validar -- datasets/dataset2.txt gabarito/respostas2.json
 */
import { readFileSync } from "node:fs";
import {
  parseDataset,
  detectarEncontros,
  type Encontro,
  type ModoClassificacao,
} from "./deteccao.js";
import { processarArquivo } from "./motor.js";

const TOLERANCIA_METROS = 1e-6;

/** Chave canonica: tipo + par ordenado + timestamp. Ignora ordem dos IDs. */
function chave(e: Encontro): string {
  const ids = [...e.monitoradosEncontro].sort((x, y) => x - y).join(",");
  return `${e.tipo}|${ids}|${e.timestamp}`;
}

function indexar(lista: Encontro[]): Map<string, Encontro[]> {
  const mapa = new Map<string, Encontro[]>();
  for (const e of lista) {
    const k = chave(e);
    const bucket = mapa.get(k);
    if (bucket) bucket.push(e);
    else mapa.set(k, [e]);
  }
  return mapa;
}

function comparar(obtidos: Encontro[], esperados: Encontro[]) {
  const idxObtidos = indexar(obtidos);
  const idxEsperados = indexar(esperados);

  const faltando: Encontro[] = [];
  const sobrando: Encontro[] = [];
  const distanciaDivergente: Array<{
    chave: string;
    obtido: number;
    esperado: number;
  }> = [];

  for (const [k, lista] of idxEsperados) {
    const obtido = idxObtidos.get(k);
    if (!obtido) {
      faltando.push(...lista);
      continue;
    }
    const d1 = lista[0]!.distanciaMetros;
    const d2 = obtido[0]!.distanciaMetros;
    if (Math.abs(d1 - d2) > TOLERANCIA_METROS) {
      distanciaDivergente.push({ chave: k, obtido: d2, esperado: d1 });
    }
  }

  for (const [k, lista] of idxObtidos) {
    if (!idxEsperados.has(k)) sobrando.push(...lista);
  }

  return { faltando, sobrando, distanciaDivergente };
}

const [caminhoDataset, caminhoGabarito] = process.argv.slice(2);

if (!caminhoDataset || !caminhoGabarito) {
  console.error(
    "Uso: npx tsx src/validar.ts datasets/dataset1.txt gabarito/respostas1.json"
  );
  process.exit(1);
}

const posicoes = parseDataset(readFileSync(caminhoDataset, "utf8"));
const esperados = JSON.parse(readFileSync(caminhoGabarito, "utf8")) as Encontro[];

console.log(`dataset: ${caminhoDataset}  (${posicoes.length} posicoes)`);
console.log(`gabarito: ${caminhoGabarito}  (${esperados.length} encontros)\n`);

const contagemGabarito = { generico: 0, faccao: 0, protetiva: 0 };
for (const e of esperados) {
  if (e.tipo in contagemGabarito) contagemGabarito[e.tipo]++;
}
console.log(
  `tipos no gabarito: generico ${contagemGabarito.generico}, ` +
    `faccao ${contagemGabarito.faccao}, protetiva ${contagemGabarito.protetiva}\n`
);

let vencedor: ModoClassificacao | null = null;

for (const modo of ["prioridade", "todos"] as ModoClassificacao[]) {
  const obtidos = detectarEncontros(posicoes, modo);
  const { faltando, sobrando, distanciaDivergente } = comparar(obtidos, esperados);

  const score = esperados.length - faltando.length - sobrando.length;
  const ok = faltando.length === 0 && sobrando.length === 0 && distanciaDivergente.length === 0;

  console.log(`--- modo "${modo}" ---`);
  console.log(`  detectados       : ${obtidos.length}`);
  console.log(`  faltando         : ${faltando.length}`);
  console.log(`  falsos positivos : ${sobrando.length}`);
  console.log(`  distancia fora da tolerancia: ${distanciaDivergente.length}`);
  console.log(`  score estimado (acertos - erros): ${score}`);
  console.log(`  ${ok ? "BATE 100% COM O GABARITO" : "divergente"}`);

  for (const e of faltando.slice(0, 3)) {
    console.log(
      `    faltando: ${e.tipo} ${JSON.stringify(e.monitoradosEncontro)} ${e.timestamp} (${e.distanciaMetros} m)`
    );
  }
  for (const e of sobrando.slice(0, 3)) {
    console.log(
      `    falso positivo: ${e.tipo} ${JSON.stringify(e.monitoradosEncontro)} ${e.timestamp} (${e.distanciaMetros} m)`
    );
  }
  for (const d of distanciaDivergente.slice(0, 3)) {
    console.log(
      `    distancia: ${d.chave} obtido=${d.obtido} esperado=${d.esperado}`
    );
  }
  console.log();

  if (ok && vencedor === null) vencedor = modo;
}

// O CLI de producao usa o motor em streaming: confirmar que ele tambem bate.
{
  const { faltando, sobrando, distanciaDivergente } = comparar(
    processarArquivo(caminhoDataset).encontros,
    esperados
  );
  const ok = faltando.length === 0 && sobrando.length === 0 && distanciaDivergente.length === 0;
  console.log(
    `--- motor em streaming (usado por npm run run:all) ---\n  ` +
      (ok ? "BATE 100% COM O GABARITO" : `divergente: faltando ${faltando.length}, falsos positivos ${sobrando.length}`) +
      "\n"
  );
  if (!ok) vencedor = null;
}

if (vencedor) {
  console.log(
    `CONCLUSAO: use modo "${vencedor}".` +
      (vencedor === "prioridade"
        ? " Ja e o padrao, nada a fazer."
        : " Rode a geracao final com MODO=todos.")
  );
  process.exit(0);
}

console.log(
  "CONCLUSAO: nenhum modo reproduziu o gabarito exatamente.\n" +
    "Veja as amostras acima: se ha apenas 'faltando', a regra de classificacao\n" +
    "do gabarito e mais ampla; se ha apenas 'falsos positivos', e mais restrita."
);
process.exit(1);
