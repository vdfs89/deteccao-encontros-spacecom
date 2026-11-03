/**
 * Prova de equivalencia: o motor em streaming (motor.ts) produz exatamente os
 * mesmos encontros que a implementacao de referencia em memoria (deteccao.ts),
 * e a versao em threads (paralelo.ts) produz o mesmo que o motor.
 *
 * Uso:
 *   npx tsx src/comparar.ts datasets/dataset1.txt datasets/dataset3.txt ...
 *
 * So aceita arquivos que caibam numa string do V8 (< ~512 MB), limite da
 * propria referencia.
 */
import { readFileSync } from "node:fs";
import { parseDataset, detectarEncontros, type Encontro } from "./deteccao.js";
import { processarArquivo } from "./motor.js";
import { processarArquivoParalelo } from "./paralelo.js";

function chave(e: Encontro): string {
  const ids = [...e.monitoradosEncontro].sort((x, y) => x - y).join(",");
  const pos = ids
    .split(",")
    .map((id) => `${e.posicoes[id]!.lat},${e.posicoes[id]!.lon}`)
    .join("|");
  return `${e.tipo}|${ids}|${e.timestamp}|${pos}|${e.distanciaMetros}`;
}

let falhou = false;

for (const caminho of process.argv.slice(2)) {
  const referencia = detectarEncontros(parseDataset(readFileSync(caminho, "utf8")));
  const motor = processarArquivo(caminho).encontros;

  const a = referencia.map(chave).sort();
  const b = motor.map(chave).sort();
  const iguais = a.length === b.length && a.every((k, i) => k === b[i]);

  console.log(
    `${caminho}: referencia ${a.length}, motor ${b.length} -> ` +
      (iguais ? "IDENTICOS (bit a bit, inclusive distancia)" : "DIVERGENTES")
  );
  if (!iguais) {
    falhou = true;
    const sb = new Set(b);
    const sa = new Set(a);
    for (const k of a) if (!sb.has(k)) console.log(`  so na referencia: ${k}`);
    for (const k of b) if (!sa.has(k)) console.log(`  so no motor: ${k}`);
  }

  // Paralelo com 6 trechos, mesmo em arquivo pequeno. Tem que dar o mesmo
  // resultado da versao de uma thread so, e na mesma ordem.
  const paralelo = (await processarArquivoParalelo(caminho, 6, 0)).encontros;
  const ordemIgual =
    paralelo.length === motor.length && paralelo.every((e, i) => chave(e) === chave(motor[i]!));
  console.log(`  paralelo (6 threads): ${paralelo.length} -> ${ordemIgual ? "IDENTICO ao motor" : "DIVERGENTE"}`);
  if (!ordemIgual) falhou = true;
}

process.exit(falhou ? 1 : 0);
