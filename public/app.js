const el = (id) => document.getElementById(id);

const ui = {
  resumo: el('resumo'),
  lateral: el('lateral'),
  lista: el('lista'),
  cabecalho: el('cabecalho-lista'),
  busca: el('busca'),
  ordem: el('ordem'),
  atualizar: el('atualizar'),
  modal: el('modal'),
  modalFrame: el('modal-frame'),
  modalTitulo: el('modal-titulo'),
  modalNovaAba: el('modal-nova-aba'),
  modalFechar: el('modal-fechar'),
  aviso: el('aviso'),
};

const TODOS = '__todos__';

const estado = {
  index: null,
  etag: null,
  projeto: localStorage.getItem('artefatos:projeto') || TODOS,
  termo: '',
  ordem: localStorage.getItem('artefatos:ordem') || 'createdAt',
};

ui.ordem.value = estado.ordem;

// ------------------------------------------------------------------- dados

async function carregar({ force = false, silencioso = false } = {}) {
  if (!silencioso) ui.atualizar.classList.add('girando');
  try {
    const resp = await fetch(`/api/index${force ? '?force=1' : ''}`, {
      headers: estado.etag && silencioso ? { 'If-None-Match': estado.etag } : {},
    });

    if (resp.status === 304) return false;
    if (!resp.ok) throw new Error(`servidor respondeu ${resp.status}`);

    const index = await resp.json();
    const mudou = index.etag !== estado.etag;
    estado.index = index;
    estado.etag = index.etag;
    render();
    return mudou;
  } catch (err) {
    avisar(`Falha ao ler o índice: ${err.message}`);
    return false;
  } finally {
    ui.atualizar.classList.remove('girando');
  }
}

function projetoAtual() {
  if (!estado.index) return null;
  if (estado.projeto === TODOS) return null;
  return estado.index.projects.find((p) => p.slug === estado.projeto) || null;
}

function artefatosVisiveis() {
  if (!estado.index) return [];

  const p = projetoAtual();
  let itens = p
    ? p.artifacts.map((a) => ({ ...a, _projeto: p }))
    : estado.index.projects.flatMap((proj) => proj.artifacts.map((a) => ({ ...a, _projeto: proj })));

  const termo = estado.termo.trim().toLowerCase();
  if (termo) {
    itens = itens.filter((a) =>
      `${a.displayTitle} ${a.description || ''} ${a.fileName} ${a.label || ''} ${a._projeto.name}`
        .toLowerCase()
        .includes(termo)
    );
  }

  const cmp = {
    createdAt: (a, b) => str(b.createdAt).localeCompare(str(a.createdAt)),
    'createdAt-asc': (a, b) => str(a.createdAt).localeCompare(str(b.createdAt)),
    updatedAt: (a, b) => str(b.updatedAt).localeCompare(str(a.updatedAt)),
    title: (a, b) => a.displayTitle.localeCompare(b.displayTitle, 'pt-BR'),
  }[estado.ordem];

  return itens.sort(cmp);
}

const str = (v) => String(v || '');

// ---------------------------------------------------------------- renderize

function render() {
  if (!estado.index) return;
  renderResumo();
  renderLateral();
  renderLista();
}

function renderResumo() {
  const t = estado.index.totals;
  const s = estado.index.scan;
  const partes = [
    `${t.artifacts} artefatos`,
    `${t.published} publicados`,
    `${t.projects} projetos`,
    t.archived ? `${t.archived} só no banco` : null,
    t.lost ? `${t.lost} perdidos` : null,
    `varredura em ${s.ms} ms`,
  ].filter(Boolean);
  ui.resumo.innerHTML = `<span class="pulso"></span>${partes.join(' · ')}`;
}

function renderLateral() {
  // Um projeto só com artefatos locais some do índice quando /tmp é limpo —
  // sem isso a seleção salva vira uma seleção fantasma, sem nada marcado.
  if (estado.projeto !== TODOS && !estado.index.projects.some((p) => p.slug === estado.projeto)) {
    estado.projeto = TODOS;
    localStorage.setItem('artefatos:projeto', TODOS);
  }

  const total = estado.index.totals.artifacts;
  const partes = [
    '<div class="grupo-titulo">Projetos</div>',
    botaoProjeto({ slug: TODOS, name: 'Todos os projetos', count: total }, estado.projeto === TODOS),
  ];

  for (const p of estado.index.projects) {
    partes.push(botaoProjeto(p, estado.projeto === p.slug));
  }

  ui.lateral.innerHTML = partes.join('');

  ui.lateral.querySelectorAll('.item-projeto').forEach((btn) => {
    btn.addEventListener('click', () => {
      estado.projeto = btn.dataset.slug;
      localStorage.setItem('artefatos:projeto', estado.projeto);
      render();
      document.querySelector('.conteudo').scrollTop = 0;
    });
  });
}

function botaoProjeto(p, ativo) {
  return `<button class="item-projeto" data-slug="${attr(p.slug)}" aria-current="${ativo}">
    <span class="item-nome">${esc(p.name)}</span>
    <span class="item-contagem">${p.count}</span>
  </button>`;
}

function renderLista() {
  const p = projetoAtual();
  const itens = artefatosVisiveis();

  ui.cabecalho.innerHTML = p
    ? `<div>
         <h2>${esc(p.name)}</h2>
         <p class="caminho">${esc(p.path || p.slug)}${p.resolved ? '' : ' <em>(caminho não confirmado)</em>'}</p>
       </div>
       <div class="contagens">${p.publishedCount} publicados · ${p.localCount} locais${
        p.archivedCount ? ` · ${p.archivedCount} só no banco` : ''
      }${p.lostCount ? ` · ${p.lostCount} perdidos` : ''}</div>`
    : `<div><h2>Todos os projetos</h2>
         <p class="caminho">${esc(estado.index.scratchRoot)} + transcripts do Claude Code</p></div>
       <div class="contagens">${itens.length} artefatos</div>`;

  if (!itens.length) {
    ui.lista.innerHTML = `<div class="vazio"><strong>Nada por aqui</strong>${
      estado.termo ? 'Nenhum artefato bate com a busca.' : 'Este projeto ainda não tem artefatos.'
    }</div>`;
    return;
  }

  const agrupar = estado.ordem !== 'title';
  let ultimoDia = null;
  const partes = [];

  for (const a of itens) {
    if (agrupar) {
      const campo = estado.ordem.startsWith('updatedAt') ? a.updatedAt : a.createdAt;
      const dia = rotuloDia(campo);
      if (dia !== ultimoDia) {
        partes.push(`<div class="dia">${esc(dia)}</div>`);
        ultimoDia = dia;
      }
    }
    partes.push(cartao(a, !p));
  }

  ui.lista.innerHTML = partes.join('');
  ligarCartoes();
}

const ESTADOS = {
  disco: { selo: '', classe: '' },
  arquivado: {
    selo: '<span class="selo arquivado" title="O arquivo sumiu do /tmp, mas o conteúdo está guardado no banco">🗄 arquivado</span>',
    classe: ' arquivado',
  },
  perdido: {
    selo: '<span class="selo ausente" title="Sem arquivo no disco e sem cópia no banco">perdido</span>',
    classe: ' ausente',
  },
};

function cartao(a, mostrarProjeto) {
  const estado = ESTADOS[a.state] || ESTADOS.perdido;
  const selos = [
    a.url ? '<span class="selo publicado">☁ publicado</span>' : '<span class="selo local">local</span>',
    estado.selo,
    a.publishCount > 1 ? `<span class="selo versoes">${a.publishCount} publicações</span>` : '',
    a.snapshotCount > 1 ? `<span class="selo versoes" title="Versões guardadas no banco">${a.snapshotCount} versões</span>` : '',
  ].filter(Boolean);

  const meta = [
    `<span title="${attr(dataCompleta(a.createdAt))}">${esc(dataCurta(a.createdAt))}</span>`,
    ...selos,
    mostrarProjeto ? `<span>${esc(a._projeto.name)}</span>` : '',
    `<span class="arquivo" title="${attr(a.path)}">${esc(a.subPath ? `${a.subPath}/${a.fileName}` : a.fileName)}</span>`,
    a.dateSource === 'mtime' ? '<span title="Sistema de arquivos não expõe data de criação">data = modificação</span>' : '',
  ].filter(Boolean);

  const acoes = [
    a.readable ? `<a class="btn btn-primario" href="/view/${a.id}" target="_blank" rel="noopener" data-parar>Abrir</a>` : '',
    a.url ? `<a class="btn" href="${attr(a.url)}" target="_blank" rel="noopener" data-parar>claude.ai</a>` : '',
    a.readable ? `<button class="btn" data-acao="salvar" data-id="${attr(a.id)}" data-parar>Salvar cópia</button>` : '',
    `<button class="btn" data-acao="copiar" data-valor="${attr(a.url || a.path)}" data-parar>Copiar ${a.url ? 'URL' : 'caminho'}</button>`,
    // Contrapartida do `prune`, que é em lote: remove um registro específico.
    a.state !== 'disco'
      ? `<button class="btn btn-perigo" data-acao="esquecer" data-id="${attr(a.id)}" data-titulo="${attr(a.displayTitle)}" data-parar>Esquecer</button>`
      : '',
  ].filter(Boolean);

  return `<article class="cartao${estado.classe}" tabindex="0" data-id="${attr(a.id)}"
    data-titulo="${attr(a.displayTitle)}" data-legivel="${a.readable}">
    <div class="cartao-icone">${esc(a.favicon || '📄')}</div>
    <div class="cartao-titulo">${esc(a.displayTitle)}</div>
    <div class="cartao-acoes">${acoes.join('')}</div>
    ${a.description ? `<div class="cartao-desc">${esc(a.description)}</div>` : ''}
    <div class="cartao-meta">${meta.join('')}</div>
  </article>`;
}

function ligarCartoes() {
  ui.lista.querySelectorAll('[data-parar]').forEach((n) => {
    n.addEventListener('click', (ev) => ev.stopPropagation());
  });

  ui.lista.querySelectorAll('[data-acao="copiar"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await navigator.clipboard.writeText(btn.dataset.valor);
      avisar('Copiado para a área de transferência');
    });
  });

  ui.lista.querySelectorAll('[data-acao="salvar"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const resp = await fetch('/api/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: btn.dataset.id }),
        });
        const data = await resp.json();
        avisar(resp.ok ? `Cópia salva em ${data.saved}` : `Não deu: ${data.error}`);
      } finally {
        btn.disabled = false;
      }
    });
  });

  ui.lista.querySelectorAll('[data-acao="esquecer"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Remover "${btn.dataset.titulo}" do catálogo?\n\nApaga o registro e o conteúdo arquivado. Não desfaz.`)) return;
      btn.disabled = true;
      try {
        const resp = await fetch('/api/forget', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: btn.dataset.id }),
        });
        const data = await resp.json();
        if (resp.ok) {
          avisar('Removido do catálogo');
          await carregar({ force: true });
        } else {
          avisar(`Não deu: ${data.error}`);
        }
      } finally {
        btn.disabled = false;
      }
    });
  });

  ui.lista.querySelectorAll('.cartao').forEach((c) => {
    const abrir = () => {
      if (c.dataset.legivel !== 'true') {
        avisar('Sem arquivo no disco e sem cópia arquivada — resta o link do claude.ai.');
        return;
      }
      abrirModal(c.dataset.id, c.dataset.titulo);
    };
    c.addEventListener('click', abrir);
    c.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        abrir();
      }
    });
  });
}

// ------------------------------------------------------------------- modal

function abrirModal(id, titulo) {
  ui.modalTitulo.textContent = titulo;
  ui.modalNovaAba.href = `/view/${id}`;
  ui.modalFrame.src = `/view/${id}`;
  ui.modal.hidden = false;
}

function fecharModal() {
  ui.modal.hidden = true;
  ui.modalFrame.src = 'about:blank';
}

ui.modalFechar.addEventListener('click', fecharModal);

// ------------------------------------------------------------------ auxílio

let avisoTimer;
function avisar(msg) {
  ui.aviso.textContent = msg;
  ui.aviso.hidden = false;
  clearTimeout(avisoTimer);
  avisoTimer = setTimeout(() => (ui.aviso.hidden = true), 4000);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const attr = esc;

function rotuloDia(iso) {
  if (!iso) return 'Sem data';
  const d = new Date(iso);
  const hoje = new Date();
  const ontem = new Date(hoje.getTime() - 86400000);
  const mesmoDia = (a, b) => a.toDateString() === b.toDateString();
  if (mesmoDia(d, hoje)) return 'Hoje';
  if (mesmoDia(d, ontem)) return 'Ontem';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
}

function dataCurta(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function dataCompleta(iso) {
  if (!iso) return 'sem data';
  return `Criado em ${new Date(iso).toLocaleString('pt-BR', { dateStyle: 'full', timeStyle: 'short' })}`;
}

// ------------------------------------------------------------------ eventos

ui.busca.addEventListener('input', () => {
  estado.termo = ui.busca.value;
  renderLista();
});

ui.ordem.addEventListener('change', () => {
  estado.ordem = ui.ordem.value;
  localStorage.setItem('artefatos:ordem', estado.ordem);
  renderLista();
});

ui.atualizar.addEventListener('click', async () => {
  const mudou = await carregar({ force: true });
  avisar(mudou ? 'Índice atualizado' : 'Nada mudou desde a última varredura');
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    if (!ui.modal.hidden) return fecharModal();
    if (document.activeElement === ui.busca) {
      ui.busca.value = '';
      estado.termo = '';
      ui.busca.blur();
      renderLista();
    }
  }
  if (ev.key === '/' && document.activeElement !== ui.busca) {
    ev.preventDefault();
    ui.busca.focus();
  }
});

// Monitoramento: reescaneia periodicamente; o ETag evita re-render à toa.
carregar();
setInterval(() => {
  if (document.hidden || !ui.modal.hidden) return;
  carregar({ silencioso: true });
}, 8000);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) carregar({ silencioso: true });
});
