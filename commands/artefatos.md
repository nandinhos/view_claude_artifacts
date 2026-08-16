---
description: Artefatos do Claude Code deste projeto, do mais recente para o mais antigo. Sem argumento lista o projeto atual; `abrir` sobe a interface web; `todos` lista todos os projetos; `status` mostra o banco e o container; qualquer outra palavra vira busca.
argument-hint: [abrir | todos | status | termo de busca]
allowed-tools: Bash({{ARTEFATOS_DIR}}/bin/artefatos:*), Bash(docker:*), Bash(curl:*), Bash(wslview:*), Bash(explorer.exe:*), Bash(xdg-open:*), Bash(open:*)
---

# /artefatos

Catálogo dos artefatos que o Claude Code gerou — os publicados no `claude.ai` e
os HTMLs que ficaram só no scratchpad. Tudo vem do SQLite, então **não depende
do container estar no ar**.

O CLI é `{{ARTEFATOS_DIR}}/bin/artefatos` (chamado de `ART` abaixo) — use esse
wrapper, não o `.js` direto: ele é que silencia o aviso experimental do
`node:sqlite`. A interface web, quando sobe, fica em
`http://127.0.0.1:{{ARTEFATOS_PORT}}`.

## O que rodar

Leia `$ARGUMENTS` e execute **um** comando:

| `$ARGUMENTS` | Comando |
|---|---|
| vazio | `ART aqui --limit 15` — artefatos do projeto onde a sessão está |
| `todos` | `ART list` |
| `status` | `ART stats` |
| `abrir` | ver o passo a passo abaixo |
| qualquer outra coisa | `ART list "<o argumento inteiro>"` — busca por nome de projeto |

### `abrir`

1. `curl -sf -o /dev/null http://127.0.0.1:{{ARTEFATOS_PORT}}/api/health` — se sair 0, já está no ar; pule para o passo 3.
2. `docker compose --project-directory {{ARTEFATOS_DIR}} up -d`, espere alguns segundos e repita o passo 1. (Sem `cd`: assim o comando casa com o `allowed-tools` e não pede permissão.) Se o Docker não existir, avise que dá para rodar `{{ARTEFATOS_DIR}}/bin/artefatos` direto e pare.
3. Abra no navegador: `wslview http://127.0.0.1:{{ARTEFATOS_PORT}}` — se falhar, tente `xdg-open` e depois `open`.
4. Informe a URL em uma linha.

## Regras

- **Reproduza a saída do CLI como ela veio.** Já chega ordenada por data de
  criação e formatada; não reescreva, não reordene, não resuma em prosa.
- Um comando por vez, esperando a saída. Nada de varrer `/tmp`, `~/.claude` ou
  os transcripts por conta própria — é exatamente isso que o CLI faz, e bem
  mais rápido, com cache.
- Se vier "Nenhum artefato registrado para …", diga isso em uma linha e sugira
  `/artefatos todos`. Não investigue o porquê.
- Só abra o navegador quando o argumento for `abrir`.
- `☁` = publicado no `claude.ai` · `(arquivado)` = o arquivo sumiu do `/tmp`,
  mas o conteúdo está salvo no banco · `(perdido)` = resta só o link.
- Ao final, ofereça em uma linha o que faz sentido a seguir: `/artefatos abrir`
  para ver na interface, ou `/artefatos <projeto>` para outro projeto.

$ARGUMENTS
