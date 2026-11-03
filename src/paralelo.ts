/**
 * Divide o arquivo em trechos e processa cada um numa thread (worker_threads).
 *
 * Os cortes caem sempre numa troca de timestamp. Como cada encontro so compara
 * posicoes do mesmo timestamp, os trechos sao independentes: cada worker roda o
 * motor.ts normal no seu pedaco e no fim eu so junto as listas, na ordem.
 *
 * Arquivos pequenos rodam numa thread so, porque abrir worker custa algumas
 * dezenas de milissegundos e nao compensa.
 */
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { openSync, readSync, closeSync, fstatSync } from "node:fs";
import { availableParallelism } from "node:os";
import { processarArquivo, type Faixa, type ResultadoMotor } from "./motor.js";

const MINIMO_PARA_PARALELO = 32 * 1024 * 1024;
const QUEBRA_LINHA = 10;
const PONTO_E_VIRGULA = 59;

interface Tarefa {
  caminho: string;
  faixa: Faixa;
}

// Dentro do worker: processa o trecho e devolve o resultado.
if (!isMainThread && parentPort && (workerData as Tarefa | undefined)?.faixa) {
  const { caminho, faixa } = workerData as Tarefa;
  parentPort.postMessage(processarArquivo(caminho, faixa, true));
}

/** Texto do 3o campo (timestamp) da linha buf[inicio, fim), ou null. */
function timestampDaLinha(buf: Buffer, inicio: number, fim: number): string | null {
  let campo = 0;
  let comeco = -1;
  for (let i = inicio; i < fim; i++) {
    if (buf[i] !== PONTO_E_VIRGULA) continue;
    campo++;
    if (campo === 2) comeco = i + 1;
    else if (campo === 3) return buf.toString("latin1", comeco, i);
  }
  return null;
}

/**
 * Primeiro byte, a partir de `alvo`, onde comeca uma linha com timestamp
 * diferente da linha anterior. Devolve `tamanho` se chegar ao fim do arquivo.
 */
function proximaTrocaDeTimestamp(fd: number, alvo: number, tamanho: number): number {
  let janela = 1024 * 1024;
  for (;;) {
    const buf = Buffer.allocUnsafe(Math.min(janela, tamanho - alvo));
    const lidos = readSync(fd, buf, 0, buf.length, alvo);
    const chegouNoFim = alvo + lidos >= tamanho;

    // Pula a linha em que o alvo caiu (provavelmente cortada no meio).
    let i = buf.indexOf(QUEBRA_LINHA, 0);
    if (i < 0) {
      if (chegouNoFim) return tamanho;
      janela *= 2;
      continue;
    }
    let anterior: string | null = null;
    for (let inicio = i + 1; inicio < lidos; ) {
      const fim = buf.indexOf(QUEBRA_LINHA, inicio);
      if (fim < 0) break; // linha incompleta: precisa de janela maior
      const ts = timestampDaLinha(buf, inicio, fim);
      if (anterior !== null && ts !== null && ts !== anterior) return alvo + inicio;
      if (ts !== null) anterior = ts;
      inicio = fim + 1;
    }
    if (chegouNoFim) return tamanho;
    janela *= 2;
  }
}

function dividirEmFaixas(caminho: string, partes: number): Faixa[] {
  const fd = openSync(caminho, "r");
  try {
    const tamanho = fstatSync(fd).size;
    const cortes = [0];
    for (let k = 1; k < partes; k++) {
      const corte = proximaTrocaDeTimestamp(fd, Math.floor((tamanho * k) / partes), tamanho);
      if (corte > cortes[cortes.length - 1]! && corte < tamanho) cortes.push(corte);
    }
    cortes.push(tamanho);
    const faixas: Faixa[] = [];
    for (let k = 0; k + 1 < cortes.length; k++) faixas.push({ inicio: cortes[k]!, fim: cortes[k + 1]! });
    return faixas;
  } finally {
    closeSync(fd);
  }
}

function rodarWorker(tarefa: Tarefa): Promise<ResultadoMotor> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), { workerData: tarefa });
    worker.once("message", resolve);
    worker.once("error", reject);
    worker.once("exit", (codigo) => {
      if (codigo !== 0) reject(new Error(`worker terminou com codigo ${codigo}`));
    });
  });
}

export async function processarArquivoParalelo(
  caminho: string,
  threads = availableParallelism(),
  minimoBytes = MINIMO_PARA_PARALELO // o comparar.ts passa 0 para testar o paralelo em arquivo pequeno
): Promise<ResultadoMotor> {
  const fd = openSync(caminho, "r");
  const tamanho = fstatSync(fd).size;
  closeSync(fd);
  if (threads <= 1 || tamanho < minimoBytes) return processarArquivo(caminho);

  const faixas = dividirEmFaixas(caminho, threads);
  const resultados = await Promise.all(faixas.map((faixa) => rodarWorker({ caminho, faixa })));

  // Cada worker ja confere que os timestamps dele vem agrupados. Falta conferir
  // que nenhum timestamp aparece em dois trechos diferentes.
  const todos = new Set<string>();
  let soma = 0;
  for (const r of resultados) {
    for (const ts of r.timestampsVistos ?? []) todos.add(ts);
    soma += r.timestamps;
  }
  if (todos.size !== soma) {
    throw new Error("Arquivo fora de ordem: um timestamp aparece em trechos diferentes.");
  }

  return {
    encontros: resultados.flatMap((r) => r.encontros),
    linhas: resultados.reduce((t, r) => t + r.linhas, 0),
    timestamps: soma,
  };
}
