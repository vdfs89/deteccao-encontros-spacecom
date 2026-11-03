# Detecção de Encontros - Trainee Tech Spacecom 2027

Vitor Silva

Esse projeto lê os arquivos de posicionamento das tornozeleiras e dos
rastreadores das vítimas e encontra os momentos em que duas pessoas ficaram a
menos de 20 metros uma da outra no mesmo timestamp. Cada encontro sai
classificado como `protetiva`, `faccao` ou `generico`.

Fiz em TypeScript, rodando com Node.js. Não usei nenhuma biblioteca além das
ferramentas de build (`typescript` e `tsx`).

## Como rodar

Precisa de Node 18 ou mais novo.

```bash
npm install

# testes (não precisam dos datasets)
npm run teste

# conferir contra os gabaritos que vieram no e-mail
npm run validar -- datasets/dataset1.txt gabarito/respostas1.json
npm run validar -- datasets/dataset2.txt gabarito/respostas2.json

# compila e gera os 7 JSONs em output/
npm run run:all
```

O `run:all` compila com `tsc` e roda com `node` puro, sem o `tsx`. Assim não
entra no tempo o custo de compilar TypeScript na hora.

Os testes também rodam no GitHub Actions a cada push
(`.github/workflows/testes.yml`).

Os datasets não vão no zip porque somam mais de 1 GB. Basta colocar
`dataset1.txt` até `dataset7.txt` na pasta `datasets/` (os links estão em
`datasets/LEIA-ME.txt`). Os JSONs que eu gerei já estão em `output/`.

## Resultado

| Dataset | Linhas | Encontros (gen / fac / prot) | Tempo |
|---|---:|---|---:|
| 1 | 5.000 | 4 (2 / 1 / 1) | 18 ms |
| 2 | 25.000 | 6 (3 / 2 / 1) | 25 ms |
| 3 | 100.000 | 10 (5 / 3 / 2) | 56 ms |
| 4 | 400.020 | 15 (7 / 5 / 3) | 172 ms |
| 5 | 1.000.000 | 21 (10 / 7 / 4) | 283 ms |
| 6 | 8.000.000 | 27 (12 / 9 / 6) | 810 ms |
| 7 | 12.000.000 | 35 (15 / 12 / 8) | 1,2 s |

Medido na minha máquina (Windows 10, Node 22, 6 núcleos). O tempo conta
leitura do arquivo, parse e detecção, só não conta a escrita do JSON. Os
datasets 1 e 2 batem 100% com os gabaritos, inclusive no valor da distância.

Para ter uma ideia da evolução, no dataset7: a primeira versão não conseguia
nem abrir o arquivo, a versão em streaming levava 6,3 s e a versão com threads
leva 1,2 s.

## Como funciona

### As regras

- Distância por Haversine com raio da Terra de 6.371.000 m.
- É encontro se a distância for menor que 20 m. Exatamente 20 não conta.
- Só comparo posições com o mesmo timestamp.
- Cada par aparece uma vez por timestamp, com os IDs em ordem crescente.

### Classificação

Quem tem `medidaProtetiva = true` é a vítima, e é a vítima que carrega a lista
de agressores em `idsRestricaoMedida`. O agressor vem com esse campo vazio.
Então a pergunta certa é "a vítima A tem o B na lista dela?", testando para os
dois lados do par. Na minha primeira versão eu fazia essa checagem ao
contrário, e nenhum encontro protetivo era detectado.

Facção é quando os dois têm `faccaoMonitorado` preenchido e igual. Todo o resto
é genérico.

Uma coisa que o enunciado não deixa claro: se um par é da mesma facção, ele
conta também como genérico? Como falso positivo desconta ponto, não quis
chutar. Deixei a classificação configurável e testei os dois jeitos contra os
gabaritos. Gerar um registro por par, com o tipo mais específico (protetiva,
depois facção, depois genérico), bateu 100%. Gerar um registro por tipo deu 2 e
3 falsos positivos. Fiquei com o primeiro.

### Leitura do arquivo

O timestamp vem entre aspas no arquivo (`"2024-01-01 00:00:00"`). Se eu não
tirasse as aspas, o JSON sairia com elas e nada bateria com o gabarito. O parser
também ignora cabeçalho, linhas vazias, CRLF e linhas com coordenada inválida.
Uma coordenada `NaN` daria distância `NaN`, e isso só faria o encontro sumir sem
nenhum erro.

### Por que tem dois arquivos de detecção

Comecei com `src/deteccao.ts`, que carrega o arquivo inteiro na memória, agrupa
por timestamp num `Map` e usa uma grade espacial para não comparar todo mundo
com todo mundo. Funcionou nos datasets pequenos, mas quando baixei os oficiais
vi que o dataset7 tem 638 MB. O `readFileSync` com `"utf8"` transforma o
arquivo numa única string, e o V8 não aceita strings tão grandes. O programa
simplesmente não rodava.

Por isso escrevi o `src/motor.ts`, que é o que o `npm run run:all` usa:

1. Lê o arquivo em blocos de 8 MB. Se uma linha fica cortada no fim de um
   bloco, o pedaço vai para o começo do próximo.
2. Lê os campos direto dos bytes, sem criar string para cada linha. Isso foi o
   que mais fez diferença no tempo: o dataset5 caiu de 2,3 s para 0,5 s.
3. Os arquivos vêm ordenados por timestamp (eu conferi os 7). Então, quando o
   timestamp muda, já processo o grupo anterior e descarto. A memória fica
   constante. Se aparecer um timestamp fora de ordem, o programa para com erro,
   porque continuar daria um resultado incompleto.
4. Dentro de cada timestamp, ordeno os pontos por latitude e comparo cada ponto
   só com os seguintes, enquanto a diferença de latitude ainda permitir menos de
   20 m.

O passo 4 substituiu a grade. Ele funciona porque a distância entre dois pontos
nunca é menor que a distância só no eixo norte-sul (`R × diferença de
latitude`). Se só a latitude já dá mais de 20 m, a distância real também dá, e
como a lista está ordenada, os próximos pontos estão ainda mais longe. Dá para
parar ali sem perder nada.

Gostei de trocar a grade porque ela tinha uma pegadinha. O tamanho de uma
célula em longitude depende do cosseno da latitude. Se você calcula isso para
cada ponto separadamente, dois pontos vizinhos podem cair em células que não
são adjacentes e nunca são comparados. Na versão com grade eu resolvi isso
dimensionando a célula uma vez só, pela maior latitude do dataset. Na
varredura, esse problema nem existe.

Para ordenar, uso insertion sort em vez do `Array.sort`. Com 40 a 120 pontos
por timestamp, ele ficou uns 15% mais rápido no total, porque evita chamar uma
função de comparação a cada passo.

Mantive o `deteccao.ts` como referência porque é mais fácil de ler e de
conferir. O `src/comparar.ts` roda os dois e compara o resultado.

### Threads

Mesmo em streaming, o dataset7 levava 6 s usando um núcleo só. O
`src/paralelo.ts` divide o arquivo em um pedaço por núcleo e processa cada
pedaço num `worker_thread`.

O cuidado é onde cortar. Se um corte cair no meio de um timestamp, metade das
posições daquele instante vai para uma thread e metade para outra, e os
encontros entre elas se perdem. Por isso cada corte é empurrado para a frente
até a primeira linha em que o timestamp muda. Depois disso os pedaços são
independentes: cada thread roda o mesmo `motor.ts` e no fim eu só junto as
listas na ordem.

No fim ainda confiro que nenhum timestamp apareceu em dois pedaços. Se
aparecer, o arquivo não estava ordenado e o programa para com erro.

Arquivos menores que 32 MB rodam numa thread só. Abrir um worker custa perto de
100 ms, e no dataset4 (21 MB) testei e não compensou.

## Como eu sei que está certo

- Os dois gabaritos batem 100% (`npm run validar`).
- O `comparar.ts` mostra que o motor e a versão de referência dão exatamente o
  mesmo resultado nos datasets 1 a 6, até a última casa da distância. O
  dataset7 não cabe na referência, então cortei ele em duas metades num ponto
  em que o timestamp muda e comparei cada metade.
- O mesmo `comparar.ts` roda a versão com threads forçando 6 pedaços até nos
  arquivos pequenos, e confere que o resultado é igual ao da versão de uma
  thread, na mesma ordem.
- Os 7 JSONs gerados com threads são idênticos aos gerados sem threads.
- O `src/teste.ts` tem um teste com dados aleatórios: 2.880 pontos agrupados
  perto uns dos outros pelo Brasil todo, gerando quase mil encontros. Comparo a
  grade e o motor contra uma força bruta que testa todos os pares. Esse é o
  teste que me deixou tranquilo para otimizar.
- Além disso, tem casos pontuais: 19,9 m conta e 20,001 m não, aspas no
  timestamp, a direção da medida protetiva, facção vazia, par duplicado, CRLF
  e arquivo fora de ordem.

## Arquivos

```
src/motor.ts      leitura em streaming e detecção
src/paralelo.ts   divide o arquivo e roda o motor em várias threads
src/deteccao.ts   versão de referência em memória, com grade espacial
src/index.ts      linha de comando, grava output/respostasN.json
src/validar.ts    compara com os gabaritos
src/comparar.ts   compara motor, referência e versão com threads
src/teste.ts      testes
output/           os 7 JSONs gerados
```

## O que eu faria depois

Coisas que ficaram fora do escopo do desafio, mas que eu faria num sistema de
verdade:

- **Juntar encontros seguidos.** Hoje, se duas pessoas ficam juntas por 2
  minutos, saem 24 registros, um por timestamp. Para quem vai agir em cima disso,
  faz mais sentido um evento só, com início, fim, duração e menor distância.
- **Receber os dados em tempo real.** Em produção as posições chegam aos poucos,
  não num arquivo. O motor já processa um timestamp por vez, então daria para
  ligar ele numa fila e alertar um encontro protetivo segundos depois de
  acontecer.
- **Aceitar arquivo fora de ordem.** Hoje eu dou erro. Daria para ordenar antes
  por timestamp, em disco, sem carregar tudo na memória.
- **Alerta antes do encontro.** Para medida protetiva, o mais útil é avisar
  quando o agressor está chegando perto (500 m, por exemplo), e não só quando já
  está a 20 m.

## Sobre o uso de IA

Usei o Claude durante o desenvolvimento, como o enunciado permite. Ele foi útil
principalmente para revisar o código: a primeira versão tinha três erros (as
aspas no timestamp, a medida protetiva invertida e a grade calculada por ponto),
e foi nessa revisão que eles apareceram. Também foi conversando com ele que
percebi o problema de tamanho do dataset7 e decidi fazer a leitura em
streaming, e depois a divisão em threads.

Não aceitei nenhuma otimização sem comparar com a força bruta ou com a versão
de referência. Esses testes existem justamente para isso.
