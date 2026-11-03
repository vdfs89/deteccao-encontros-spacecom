/**
 * CLI: processa datasets e grava os JSONs de saida em output/.
 *
 * Uso:
 *   npm run run:all
 *   node dist/index.js datasets/dataset3.txt
 *   THREADS=1 node dist/index.js datasets/dataset7.txt   (forca uma thread so)
 *
 * Usa o motor em streaming (motor.ts), dividido em threads pelo paralelo.ts
 * nos arquivos grandes.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { availableParallelism } from "node:os";
import { basename, join } from "node:path";
import { processarArquivoParalelo } from "./paralelo.js";

const threads = Number(process.env.THREADS) || availableParallelism();

const arquivos = process.argv.slice(2);

if (arquivos.length === 0) {
  console.error(
    "Uso: node dist/index.js datasets/dataset1.txt [datasets/dataset2.txt ...]"
  );
  process.exit(1);
}

mkdirSync("output", { recursive: true });

let totalMs = 0;

for (const caminho of arquivos) {
  const nome = basename(caminho);
  const numero = nome.match(/(\d+)/)?.[1] ?? nome.replace(/\.txt$/i, "");

  // Leitura, parse e deteccao acontecem juntos no streaming, entao o tempo
  // medido inclui o I/O do arquivo (escrita do JSON fica de fora).
  const inicio = performance.now();
  const { encontros, linhas } = await processarArquivoParalelo(caminho, threads);
  const duracao = performance.now() - inicio;
  totalMs += duracao;

  const destino = join("output", `respostas${numero}.json`);
  writeFileSync(destino, JSON.stringify(encontros, null, 2) + "\n", "utf8");

  const contagem = { generico: 0, faccao: 0, protetiva: 0 };
  for (const e of encontros) contagem[e.tipo]++;

  console.log(
    `${nome.padEnd(16)} ${String(linhas).padStart(8)} posicoes  ` +
      `${String(encontros.length).padStart(6)} encontros  ` +
      `(generico ${contagem.generico}, faccao ${contagem.faccao}, protetiva ${contagem.protetiva})  ` +
      `${duracao.toFixed(1)} ms  -> ${destino}`
  );
}

console.log(
  `\nthreads: ${threads}  tempo total do algoritmo: ${totalMs.toFixed(1)} ms  ` +
    `(media ${(totalMs / arquivos.length).toFixed(1)} ms/dataset)`
);
