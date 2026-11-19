const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CANAIS_BASE_URL = 'https://canais-saimo.pages.dev';
const FILMES_BASE_URL = 'https://filmes-saimo.pages.dev';
const SAIMO_PROXY_URL = 'https://play.saimotv.com/api/proxy';
const OUTPUT_DIR = path.join(__dirname, 'listas');
const CACHE_FILE = path.join(OUTPUT_DIR, 'tmdb_cache.json');

const TMDB_KEY = process.env.TMDB_KEY || '4a0e81a33a44fc2b682553ef05a5e49e';
const TMDB_API = 'https://api.themoviedb.org/3';
const TMDB_IMG_POSTER = 'https://image.tmdb.org/t/p/w500';
const TMDB_IMG_BACKDROP = 'https://image.tmdb.org/t/p/w1280';
const TMDB_IMG_LOGO = 'https://image.tmdb.org/t/p/w500';

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const MAX_TMDB_FETCH_PER_RUN = 5500;
const TMDB_CONCURRENCY = 25;

const http = axios.create({
  timeout: 30000,
  headers: { 'User-Agent': DEFAULT_UA, 'Accept': 'text/plain, application/json, */*' },
  responseType: 'text',
  transformResponse: [(d) => d]
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, retries = 4) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await http.get(url);
      if (res.status >= 200 && res.status < 300 && typeof res.data === 'string' && res.data.length > 0) {
        return res.data;
      }
      if (res.status === 404) return '';
    } catch (err) {
      if (err.response && err.response.status === 404) return '';
      if (i < retries - 1) await sleep(800 * (i + 1));
    }
  }
  return '';
}

function isCommentLine(line) {
  if (!line) return true;
  if (line.startsWith('#') && !line.includes('\t')) return true;
  if (line.startsWith('# ') && line.split('\t')[0].includes('tipo')) return true;
  return false;
}

function decodificarHtml(s) {
  return String(s || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function extrairAnoDoTitulo(titulo) {
  const m = String(titulo || '').match(/\((\d{4})\)\s*$/);
  return m ? m[1] : '';
}

function normalizarTituloChave(titulo, anoOpcional = '') {
  const anoNoTitulo = extrairAnoDoTitulo(titulo);
  const anoFinal = (anoOpcional || anoNoTitulo || '').trim();

  const base = decodificarHtml(titulo)
    .replace(/\s*\(\d{4}\)\s*$/g, '')
    .replace(/\[.*?\]/g, '')
    .replace(/\b(4k|uhd|fhd|1080p|720p|hd|sd|dublado|legendado|dub|leg|dual)\b/gi, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();

  return anoFinal ? `${base}_${anoFinal}` : base;
}

function limparTituloExibicao(titulo) {
  return decodificarHtml(titulo)
    .replace(/\s*\(\d{4}\)\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseGenerosLista(strGeneros, fallback = '') {
  const brutos = String(strGeneros || fallback || '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
  return Array.from(new Set(brutos));
}

function isSaimoApiStreamUrl(url) {
  const low = String(url || '').toLowerCase();
  return low.includes('/api/stream');
}

function extrairTmdbIdDaLinha(linhaCompleta) {
  const matches = [...String(linhaCompleta || '').matchAll(/[?&]id=(\d+)/gi)].map((m) => Number(m[1]));
  return matches.length ? matches[0] : null;
}

function normalizeMediaUrl(rawUrl, referer = '', userAgent = '') {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let u = rawUrl.trim();
  if (u.startsWith('//')) u = `https:${u}`;
  if (!u.startsWith('http://') && !u.startsWith('https://')) return null;

  const low = u.toLowerCase().split('?')[0];

  if (u.includes('/api/proxy?url=') && !u.includes('format=m3u8')) {
    if (u.toLowerCase().includes('.m3u8') || u.toLowerCase().includes('.txt')) {
      return `${u}&format=m3u8`;
    }
    return `${u}&ext=.mp4`;
  }

  if (low.includes('opendrive.com/api/v1/download/file.json')) {
    return u.includes('?') ? `${u}&ext=.mp4` : `${u}?inline=1&ext=.mp4`;
  }

  if (referer || low.includes('s25-cloudfront-net.lat/')) {
    const refFinal = referer || 'https://ww0.embedtv.cc/';
    const uaFinal = userAgent || DEFAULT_UA;
    return `${SAIMO_PROXY_URL}?url=${encodeURIComponent(u)}&referer=${encodeURIComponent(refFinal)}&ua=${encodeURIComponent(uaFinal)}&format=m3u8`;
  }

  if (low.endsWith('.txt') && !u.includes('format=m3u8')) {
    u += (u.includes('?') ? '&' : '?') + 'format=m3u8';
  }

  return u;
}

async function medirVelocidadeBases(bases) {
  console.log('\n⚡ Medindo velocidade/latência dos servidores de mídia...');
  const latenciasHost = new Map();
  await Promise.all(
    Object.entries(bases).map(async ([num, baseUrl]) => {
      let host = '';
      try { host = new URL(baseUrl).host; } catch (_) { return; }
      if (latenciasHost.has(host)) return;
      const t0 = Date.now();
      try {
        await axios.head(baseUrl, { timeout: 4000, headers: { 'User-Agent': DEFAULT_UA }, validateStatus: () => true });
        const ms = Date.now() - t0;
        latenciasHost.set(host, ms);
        console.log(`  [Base ${num}] ${host} -> ${ms}ms`);
      } catch (_) {
        latenciasHost.set(host, 9999);
      }
    })
  );
  return latenciasHost;
}

function pontosQualidade(qStr, url = '') {
  const q = String(qStr || '').toLowerCase();
  const u = String(url || '').toLowerCase();
  if (q === '4k' || q === 'uhd' || /\b(4k|2160p|uhd)\b/.test(u)) return 400;
  if (q === 'fhd' || q === '1080p' || /\b(fhd|1080p)\b/.test(u)) return 300;
  if (q === 'hd' || q === '720p' || /\b(720p|hd)\b/.test(u)) return 200;
  if (q === 'sd' || q === '480p') return 100;
  return 250;
}

function calcularScoreFonte(fonteObj, latenciasHost) {
  const url = fonteObj.url || '';
  if (isSaimoApiStreamUrl(url)) return -5000;

  let score = pontosQualidade(fonteObj.qualidade, url) * 10;

  if (/\.(mp4|mkv|m4v|webm)(\?|$|&)/i.test(url) && !url.includes('/api/proxy')) score += 800;
  else if (/\.m3u8(\?|$)/i.test(url)) score += 750;
  else if (url.includes('master.txt') || url.includes('format=m3u8')) score += 400;
  else if (url.includes('/api/proxy')) score += 300;
  else score += 500;

  try {
    const host = new URL(url).host;
    const ms = latenciasHost ? (latenciasHost.get(host) ?? 350) : 350;
    score += ms >= 9000 ? -1500 : Math.max(0, 400 - Math.round(ms / 10));
  } catch (_) {}

  if (fonteObj.idioma === 'dublado') score += 50;
  return score;
}

function ordenarELimparFontesDoItem(listaFontes, latenciasHost) {
  const mapa = new Map();
  for (const f of listaFontes) {
    if (!f || !f.url) continue;
    const ex = mapa.get(f.url);
    if (!ex) mapa.set(f.url, { ...f });
    else if (!ex.qualidade && f.qualidade) ex.qualidade = f.qualidade;
  }

  const todas = Array.from(mapa.values());
  const apenasDiretas = todas.filter((f) => !isSaimoApiStreamUrl(f.url));
  const escolhidas = apenasDiretas.length > 0 ? apenasDiretas : todas;

  escolhidas.sort((a, b) => calcularScoreFonte(b, latenciasHost) - calcularScoreFonte(a, latenciasHost));
  return escolhidas.map((f) => {
    const out = { url: f.url, idioma: f.idioma || 'dublado' };
    if (f.qualidade) out.qualidade = f.qualidade.toUpperCase();
    return out;
  });
}

function montarFonteComQualidade(valorBruto, idioma, bases, marcasMap) {
  if (!valorBruto) return null;
  const limpo = valorBruto.trim();
  if (!limpo) return null;
  const qualidadeMarca = marcasMap ? (marcasMap.get(limpo) || '') : '';

  if (limpo.startsWith('http://') || limpo.startsWith('https://') || limpo.startsWith('//')) {
    const urlFinal = normalizeMediaUrl(limpo);
    return urlFinal ? { url: urlFinal, idioma, qualidade: qualidadeMarca } : null;
  }

  const partes = limpo.split(':');
  if (partes.length < 2) return null;
  const baseKey = partes[0].trim();
  const resto = partes.slice(1).join(':').trim();
  const base = bases[baseKey];
  if (!base || !resto) return null;

  const baseFmt = base.endsWith('/') ? base : `${base}/`;
  const urlCrua = resto.includes('.') ? `${baseFmt}${resto}` : `${baseFmt}${resto}.mp4`;
  const urlFinal = normalizeMediaUrl(urlCrua);
  return urlFinal ? { url: urlFinal, idioma, qualidade: qualidadeMarca } : null;
}

function extrairFontes(campos, bases, marcasMap, latenciasHost) {
  const fontes = [];

  for (let i = 1; i < campos.length; i++) {
    const campo = (campos[i] || '').trim();
    if (!campo) continue;

    let idioma = 'dublado';
    let resto = campo;

    if (campo.includes('=')) {
      const idxEq = campo.indexOf('=');
      const prefixo = campo.slice(0, idxEq).toLowerCase().trim();
      resto = campo.slice(idxEq + 1).trim();
      idioma = (prefixo === 'leg' || prefixo.includes('leg')) ? 'legendado' : 'dublado';
    }

    for (const urlBruta of resto.split(',')) {
      const fObj = montarFonteComQualidade(urlBruta, idioma, bases, marcasMap);
      if (fObj) fontes.push(fObj);
    }
  }

  return ordenarELimparFontesDoItem(fontes, latenciasHost);
}

function loadTmdbCache() {
  try { return fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) : {}; } catch (_) { return {}; }
}

function saveTmdbCache(cacheObj) {
  try {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheObj), 'utf-8');
  } catch (_) {}
}

async function fetchTmdbDetails(tmdbId, tipo) {
  const url = `${TMDB_API}/${tipo}/${tmdbId}?api_key=${TMDB_KEY}&language=pt-BR&append_to_response=images&include_image_language=pt,en,null`;
  try {
    const res = await http.get(url, { timeout: 10000 });
    if (res.status !== 200 || !res.data) return null;
    const d = JSON.parse(res.data);
    const logos = (d.images && d.images.logos) || [];
    const logo = logos.find((l) => l.iso_639_1 === 'pt') || logos.find((l) => l.iso_639_1 === 'en') || logos[0];
    const releaseYear = String(d.release_date || d.first_air_date || '').slice(0, 4);
    const genres = (d.genres || []).map((g) => g.name).filter(Boolean);
    const rating = d.vote_average ? Number(d.vote_average).toFixed(1) : '';
    return {
      logo: logo && logo.file_path ? `${TMDB_IMG_LOGO}${logo.file_path}` : '',
      backdrop: d.backdrop_path ? `${TMDB_IMG_BACKDROP}${d.backdrop_path}` : '',
      poster: d.poster_path ? `${TMDB_IMG_POSTER}${d.poster_path}` : '',
      desc: (d.overview || '').trim(),
      year: releaseYear,
      genres,
      genre: genres.join(', '),
      rating
    };
  } catch (_) {
    return null;
  }
}

async function enrichItemsWithTmdbLogos(allItems, tmdbCache) {
  const itensOrdenadosPorAno = [...allItems].sort((a, b) => (parseInt(b.year, 10) || 0) - (parseInt(a.year, 10) || 0));

  const fila = [];
  for (const it of itensOrdenadosPorAno) {
    if (!it.tmdbId || !it.tmdbTipo) continue;
    const k = `${it.tmdbTipo}_${it.tmdbId}`;
    if (!tmdbCache[k]) fila.push({ key: k, tmdbId: it.tmdbId, tmdbTipo: it.tmdbTipo });
  }
  const unicos = Array.from(new Map(fila.map((x) => [x.key, x])).values()).slice(0, MAX_TMDB_FETCH_PER_RUN);

  if (unicos.length > 0) {
    console.log(`\n🎨 Buscando Capas, Logos PNG e Backdrops no TMDB para ${unicos.length} títulos...`);
    for (let i = 0; i < unicos.length; i += TMDB_CONCURRENCY) {
      const lote = unicos.slice(i, i + TMDB_CONCURRENCY);
      await Promise.all(lote.map(async (q) => {
        const info = await fetchTmdbDetails(q.tmdbId, q.tmdbTipo);
        if (info) tmdbCache[q.key] = info;
      }));
    }
    saveTmdbCache(tmdbCache);
  }

  for (const it of allItems) {
    const cached = it.tmdbId ? tmdbCache[`${it.tmdbTipo}_${it.tmdbId}`] : null;
    const logoUrl = (cached && cached.logo) || '';
    it.logo = logoUrl;
    it.bannerlogo = logoUrl;
    if (cached) {
      if (cached.backdrop) it.bannerThumb = cached.backdrop;
      if (!it.thumb && cached.poster) it.thumb = cached.poster;
      if (!it.bannerThumb && it.thumb) it.bannerThumb = it.thumb;
      if (cached.desc) it.desc = cached.desc;
      if (!it.year && cached.year) it.year = cached.year;
      if (!it.rating && cached.rating && cached.rating !== '0.0') it.rating = cached.rating;
      if ((!it.genres || it.genres.length === 0 || (it.genres.length === 1 && ['Filme', 'Série'].includes(it.genres[0]))) && cached.genres && cached.genres.length > 0) {
        it.genres = cached.genres;
        it.genre = cached.genres.join(', ');
      }
    }
  }
}

function classificarCanal(nome) {
  const n = String(nome || '').toLowerCase();
  if (/(sexy hot|playboy|adulto|venus|hustler|private|sex)/.test(n)) return 'Adulto';
  if (/(pluto)/.test(n)) return 'Pluto TV';
  if (/(espn|sportv|premiere|combate|band sports|cazé|caze|nsports|xsports)/.test(n)) return 'Esportes';
  if (/(news|globonews|cnn|record news|jovem pan|terra viva)/.test(n)) return 'Notícias';
  if (/(cartoon|nick|discovery kids|gloob|infantil|kids|boomerang)/.test(n)) return 'Infantil';
  if (/(discovery|history|animal planet|natgeo|national geographic|investigação)/.test(n)) return 'Documentários';
  if (/(hbo|telecine|megapix|paramount|tnt|space|universal|amc|cinemax|star)/.test(n)) return 'Filmes e Séries';
  if (/(globo|sbt|record|band|rede tv|redetv|cultura|gazeta)/.test(n)) return 'TV Aberta';
  return 'Variedades';
}

async function processarCanais() {
  console.log('\n📺 1. Baixando todos os canais de canais-saimo.pages.dev...');
  const [catalogoTxt, canaisM3uTxt, restritosTxt] = await Promise.all([
    fetchText(`${CANAIS_BASE_URL}/catalogo.txt`),
    fetchText(`${CANAIS_BASE_URL}/canais.txt`),
    fetchText(`${CANAIS_BASE_URL}/restritos.txt`)
  ]);

  const todosCanais = [];
  let canalAtual = null;
  let ultimaFonte = null;

  const lerCatalogo = (txt, catPadrao = '') => {
    for (let linha of (txt || '').split(/\r?\n/)) {
      linha = linha.trim();
      if (!linha || linha.startsWith('#')) continue;
      const partes = linha.split(':');
      if (partes.length < 2) continue;
      const k = partes.shift().trim().toLowerCase();
      const v = partes.join(':').trim();
      if (!v) continue;

      if (k === 'canal') {
        ultimaFonte = null;
        canalAtual = {
          nome: v,
          logo: '',
          categoria: catPadrao || classificarCanal(v),
          fontesBrutas: []
        };
        todosCanais.push(canalAtual);
      } else if (canalAtual && k === 'logo' && !canalAtual.logo) {
        canalAtual.logo = v;
      } else if (canalAtual && k === 'categoria' && !catPadrao) {
        canalAtual.categoria = v;
      } else if (canalAtual && k === 'fonte') {
        ultimaFonte = !isSaimoApiStreamUrl(v) ? { rawUrl: v, referer: '', ua: '', qualidade: '' } : null;
        if (ultimaFonte) canalAtual.fontesBrutas.push(ultimaFonte);
      } else if (ultimaFonte && k === 'qualidade') {
        ultimaFonte.qualidade = v;
      } else if (ultimaFonte && k === 'referer') {
        ultimaFonte.referer = v;
      } else if (ultimaFonte && k === 'agente') {
        ultimaFonte.ua = v;
      }
    }
  };

  lerCatalogo(catalogoTxt);
  lerCatalogo(restritosTxt, 'Adulto');

  if (canaisM3uTxt && canaisM3uTxt.includes('#EXTINF:')) {
    let pend = null;
    for (let l of canaisM3uTxt.split(/\r?\n/)) {
      l = l.trim();
      if (!l) continue;
      if (l.startsWith('#EXTINF:')) {
        const logo = (l.match(/tvg-logo="([^"]*)"/i) || [])[1] || '';
        const grp = (l.match(/group-title="([^"]*)"/i) || [])[1] || '';
        const nome = l.split(',').pop()?.trim() || '';
        pend = { nome, logo, categoria: grp || classificarCanal(nome) };
      } else if (!l.startsWith('#') && pend && !isSaimoApiStreamUrl(l)) {
        const existente = todosCanais.find((c) => c.nome.toLowerCase() === pend.nome.toLowerCase());
        if (existente) {
          existente.fontesBrutas.push({ rawUrl: l, referer: '', ua: '', qualidade: '' });
          if (!existente.logo && pend.logo) existente.logo = pend.logo;
        } else if (pend.nome) {
          todosCanais.push({
            nome: pend.nome,
            logo: pend.logo,
            categoria: pend.categoria,
            fontesBrutas: [{ rawUrl: l, referer: '', ua: '', qualidade: '' }]
          });
        }
        pend = null;
      }
    }
  }

  const out = [];
  let id = 0;
  for (const c of todosCanais) {
    const conv = c.fontesBrutas
      .map((f) => ({ url: normalizeMediaUrl(f.rawUrl, f.referer, f.ua), idioma: 'dublado', qualidade: f.qualidade }))
      .filter((f) => f.url);
    const ord = ordenarELimparFontesDoItem(conv, null);
    if (ord.length > 0) {
      id++;
      out.push({ id: String(id), nome: c.nome, categoria: c.categoria, logo: c.logo, urls: ord.map((x) => x.url) });
    }
  }
  saveJsonFile('canais_sm.json', out);
}

/**
 * 2. CARREGA METADADOS COMPLETOS (Ano, Todos os Gêneros, Rating IMDb, Classificação Etária e Popularidade)
 */
async function carregarMetadadosVOD() {
  console.log('\n🎬 2. Carregando índice, fichas, destaques, detalhes (ano/nota/idade/pop) e marcas.txt...');
  const [indiceTxt, fichasTxt, generosTxt, detalhesTxt, marcasTxt, destaquesTxt] = await Promise.all([
    fetchText(`${FILMES_BASE_URL}/indice.txt`),
    fetchText(`${FILMES_BASE_URL}/fichas.txt`),
    fetchText(`${FILMES_BASE_URL}/generos.txt`),
    fetchText(`${FILMES_BASE_URL}/detalhes.txt`),
    fetchText(`${FILMES_BASE_URL}/marcas.txt`),
    fetchText(`${FILMES_BASE_URL}/destaques.txt`)
  ]);

  const bases = {};
  const gavetas = [];

  for (let l of indiceTxt.split(/\r?\n/)) {
    l = l.trim();
    if (!l) continue;
    if (l.startsWith('base:')) {
      const p = l.replace('base:', '').trim().split(/\s+/);
      if (p.length >= 2) bases[p[0]] = p[1];
    } else if (l.includes('\t')) {
      const c = l.split('\t');
      if (c[0]) {
        gavetas.push({
          letra: c[0].trim(),
          filmes: parseInt(c[1] || '0', 10),
          series: parseInt(c[2] || '0', 10),
          reservados: parseInt(c[3] || '0', 10)
        });
      }
    }
  }

  const marcasMap = new Map();
  for (let l of (marcasTxt || '').split(/\r?\n/)) {
    const c = l.trim().split('\t');
    if (c.length >= 2 && !c[0].startsWith('#')) marcasMap.set(c[0].trim(), c[1].trim().toLowerCase());
  }

  const metaMap = new Map();
  const metaPorTmdbId = new Map();
  const normKey = (tipo, tit, ano = '') => `${tipo.toLowerCase()}|${normalizarTituloChave(tit, ano)}`;

  const getOrInit = (tipo, tit, ano = '') => {
    const kComAno = normKey(tipo, tit, ano);
    const kSemAno = `${tipo.toLowerCase()}|${normalizarTituloChave(limparTituloExibicao(tit), '')}`;

    if (!metaMap.has(kComAno)) {
      const novo = {
        tmdbId: '',
        thumb: '',
        bannerThumb: '',
        genre: '',
        genres: [],
        year: extrairAnoDoTitulo(tit) || ano || '',
        rating: '',
        age: '',
        popularity: 0,
        desc: ''
      };
      metaMap.set(kComAno, novo);
      if (!metaMap.has(kSemAno)) {
        metaMap.set(kSemAno, novo);
      }
    }
    return metaMap.get(kComAno);
  };

  const sincronizarSemAno = (tipo, tit, mObj) => {
    const kSemAno = `${tipo.toLowerCase()}|${normalizarTituloChave(limparTituloExibicao(tit), '')}`;
    const atual = metaMap.get(kSemAno);
    if (!atual || (mObj.year && mObj.year >= (atual.year || ''))) {
      metaMap.set(kSemAno, mObj);
    }
  };

  for (let l of (fichasTxt || '').split(/\r?\n/)) {
    l = l.trim();
    if (!l || isCommentLine(l) || l.startsWith('capa:')) continue;
    const c = l.split('\t');
    if (c.length >= 4) {
      const m = getOrInit(c[0], c[1]);
      if (c[2] && /^\d+$/.test(c[2].trim())) {
        m.tmdbId = Number(c[2].trim());
        metaPorTmdbId.set(`${c[0].toLowerCase()}_${m.tmdbId}`, m);
      }
      if (c[3]) {
        const img = c[3].startsWith('http') ? c[3] : `${TMDB_IMG_POSTER}${c[3].startsWith('/') ? '' : '/'}${c[3]}`;
        m.thumb = img;
        m.bannerThumb = img;
      }
      if (c[4]) {
        const gList = parseGenerosLista(c[4]);
        if (gList.length > 0) {
          m.genres = gList;
          m.genre = gList.join(', ');
        }
      }
      sincronizarSemAno(c[0], c[1], m);
    }
  }

  for (let l of (destaquesTxt || '').split(/\r?\n/)) {
    l = l.trim();
    if (!l || isCommentLine(l) || l.startsWith('capa:') || l.startsWith('fila\t')) continue;
    const c = l.split('\t');
    if (c.length >= 5 && ['f', 's', 'a', 'd'].includes(c[0])) {
      const anoDest = (c[3] || '').trim();
      const m = getOrInit(c[0], c[1], anoDest);
      if (c[4] && !m.thumb) {
        const img = c[4].startsWith('http') ? c[4] : `${TMDB_IMG_POSTER}${c[4].startsWith('/') ? '' : '/'}${c[4]}`;
        m.thumb = img;
        m.bannerThumb = img;
      }
      if (anoDest && !m.year) m.year = anoDest;
      sincronizarSemAno(c[0], c[1], m);
    }
  }

  for (let l of (generosTxt || '').split(/\r?\n/)) {
    const c = l.trim().split('\t');
    if (c.length >= 3 && !isCommentLine(l)) {
      const m = getOrInit(c[0], c[1]);
      if ((!m.genres || m.genres.length === 0) && c[2]) {
        const gList = parseGenerosLista(c[2]);
        m.genres = gList;
        m.genre = gList.join(', ');
      }
      sincronizarSemAno(c[0], c[1], m);
    }
  }

  // Lê detalhes.txt: tipo \t titulo \t ano \t nota \t classificacao \t acessos/popularidade
  for (let l of (detalhesTxt || '').split(/\r?\n/)) {
    const c = l.trim().split('\t');
    if (c.length >= 3 && !isCommentLine(l)) {
      const anoDet = (c[2] || '').trim();
      const notaDet = (c[3] || '').trim();
      const idadeDet = (c[4] || '').trim();
      const popDet = parseInt(c[5] || '0', 10) || 0;

      const m = getOrInit(c[0], c[1]);
      if (anoDet) m.year = anoDet;
      if (notaDet) m.rating = notaDet;
      if (idadeDet) m.age = idadeDet;
      if (popDet > m.popularity) m.popularity = popDet;

      if (anoDet) {
        const mComAno = getOrInit(c[0], c[1], anoDet);
        if (!mComAno.year) mComAno.year = anoDet;
        if (notaDet && !mComAno.rating) mComAno.rating = notaDet;
        if (idadeDet && !mComAno.age) mComAno.age = idadeDet;
        if (popDet > mComAno.popularity) mComAno.popularity = popDet;
        if (!mComAno.thumb && m.thumb) { mComAno.thumb = m.thumb; mComAno.bannerThumb = m.bannerThumb; }
        if (!mComAno.tmdbId && m.tmdbId) mComAno.tmdbId = m.tmdbId;
        if ((!mComAno.genres || mComAno.genres.length === 0) && m.genres.length > 0) {
          mComAno.genres = m.genres;
          mComAno.genre = m.genre;
        }
        sincronizarSemAno(c[0], c[1], mComAno);
      } else {
        sincronizarSemAno(c[0], c[1], m);
      }
    }
  }

  const buscarMeta = (tipo, tituloBruto, anoExtraido = '', tmdbIdLinha = null) => {
    const t = tipo.toLowerCase();
    return (
      (tmdbIdLinha && metaPorTmdbId.get(`${t}_${tmdbIdLinha}`)) ||
      metaMap.get(normKey(t, tituloBruto, anoExtraido)) ||
      metaMap.get(normKey(t, tituloBruto, '')) ||
      metaMap.get(`${t}|${normalizarTituloChave(limparTituloExibicao(tituloBruto), '')}`) ||
      metaMap.get(`s|${normalizarTituloChave(limparTituloExibicao(tituloBruto), '')}`) ||
      {}
    );
  };

  const latenciasHost = await medirVelocidadeBases(bases);
  return { bases, gavetas, buscarMeta, marcasMap, latenciasHost, destaquesTxt };
}

/**
 * 3. COLETA TODOS OS FILMES + RESERVADOS E TODAS AS SÉRIES
 */
async function coletarVOD(bases, gavetas, buscarMeta, marcasMap, latenciasHost) {
  const filmesCartoonzine = [];
  const seriesCartoonzine = [];

  console.log('\n🎥 3. Extraindo todos os Filmes (filmes-<LETRA>.txt + reservado-<LETRA>.txt)...');
  const todasLetras = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];

  for (let i = 0; i < todasLetras.length; i += 7) {
    const slice = todasLetras.slice(i, i + 7);
    const lote = await Promise.all(
      slice.map(async (letra) => {
        const arq = letra === '#' ? '%23' : letra;
        const [fTxt, rTxt] = await Promise.all([
          fetchText(`${FILMES_BASE_URL}/filmes-${arq}.txt`).then((t) => t || (letra === '#' ? fetchText(`${FILMES_BASE_URL}/filmes-#.txt`) : '')),
          fetchText(`${FILMES_BASE_URL}/reservado-${arq}.txt`).then((t) => t || (letra === '#' ? fetchText(`${FILMES_BASE_URL}/reservado-#.txt`) : ''))
        ]);
        return { fTxt, rTxt };
      })
    );

    for (const { fTxt, rTxt } of lote) {
      for (const [blocoTxt, generoPadrao] of [[fTxt, 'Filme'], [rTxt, 'Adulto']]) {
        for (let l of (blocoTxt || '').split(/\r?\n/)) {
          l = l.trim();
          if (!l || isCommentLine(l)) continue;

          const c = l.split('\t');
          const tituloBruto = (c[0] || '').trim();
          if (!tituloBruto) continue;

          const anoExtraido = extrairAnoDoTitulo(tituloBruto);
          const tmdbIdNaLinha = extrairTmdbIdDaLinha(l);
          const fontes = extrairFontes(c, bases, marcasMap, latenciasHost);
          if (fontes.length === 0) continue;

          const meta = buscarMeta('f', tituloBruto, anoExtraido, tmdbIdNaLinha);
          const finalTmdbId = tmdbIdNaLinha || meta.tmdbId || null;
          const genresArr = (meta.genres && meta.genres.length > 0) ? meta.genres : [generoPadrao];

          const obj = {
            cat: 'Filmes',
            title: limparTituloExibicao(tituloBruto),
            desc: meta.desc || '',
            thumb: meta.thumb || '',
            bannerThumb: meta.bannerThumb || '',
            logo: '',
            bannerlogo: '',
            year: anoExtraido || meta.year || '',
            genre: genresArr.join(', '),
            genres: genresArr,
            rating: meta.rating || '',
            age: meta.age || (generoPadrao === 'Adulto' ? '18' : ''),
            popularity: meta.popularity || 0,
            fontes
          };
          if (finalTmdbId) {
            obj.tmdbId = finalTmdbId;
            obj.tmdbTipo = 'movie';
          }

          filmesCartoonzine.push(obj);
        }
      }
    }
  }

  console.log('\n📺 4. Extraindo todas as Séries (# e A-Z)...');
  for (const letra of todasLetras) {
    const arq = letra === '#' ? '%23' : letra;
    const idxTxt = (await fetchText(`${FILMES_BASE_URL}/series-${arq}.txt`)) || (letra === '#' ? await fetchText(`${FILMES_BASE_URL}/series-#.txt`) : '');
    if (!idxTxt) continue;

    const pedacos = new Set();
    for (const l of idxTxt.split(/\r?\n/)) {
      const line = l.trim();
      if (!line || isCommentLine(line)) continue;
      const c = line.split('\t');
      if (c.length >= 3 && c[2] !== undefined && c[2].trim() !== '') {
        pedacos.add(c[2].trim());
      }
    }

    const pedacosArr = Array.from(pedacos);
    const textosPedacos = [];
    for (let i = 0; i < pedacosArr.length; i += 6) {
      const slice = pedacosArr.slice(i, i + 6);
      const lote = await Promise.all(
        slice.map(async (p) => (await fetchText(`${FILMES_BASE_URL}/series-${arq}-${p}.txt`)) || (letra === '#' ? await fetchText(`${FILMES_BASE_URL}/series-#-${p}.txt`) : ''))
      );
      textosPedacos.push(...lote);
    }

    for (const txt of textosPedacos) {
      let atual = null;
      const fechar = () => {
        if (!atual) return;
        atual.seasons = Object.keys(atual.seasonsMap).sort((a, b) => Number(a) - Number(b)).map((s) => ({
          season: parseInt(s, 10),
          episodes: atual.seasonsMap[s].map((ep) => ({ ...ep, fontes: ordenarELimparFontesDoItem(ep.fontes, latenciasHost) })).filter((ep) => ep.fontes.length > 0).sort((a, b) => a.episode - b.episode)
        })).filter((s) => s.episodes.length > 0);
        delete atual.seasonsMap;
        if (atual.seasons.length > 0) seriesCartoonzine.push(atual);
      };

      for (let l of (txt || '').split(/\r?\n/)) {
        l = l.trim();
        if (!l || isCommentLine(l)) continue;
        if (l.startsWith('@')) {
          fechar();
          const c = l.slice(1).split('\t');
          const titBruto = (c[0] || '').trim();
          const titLimpo = limparTituloExibicao(titBruto);
          const anoS = (c[1] || '').trim() || extrairAnoDoTitulo(titBruto);
          const meta = buscarMeta('s', titBruto, anoS);
          const genresArr = (meta.genres && meta.genres.length > 0) ? meta.genres : ['Série'];

          atual = {
            cat: 'Séries',
            title: titLimpo,
            desc: meta.desc || '',
            thumb: meta.thumb || '',
            bannerThumb: meta.bannerThumb || '',
            logo: '',
            bannerlogo: '',
            year: anoS || meta.year || '',
            genre: genresArr.join(', '),
            genres: genresArr,
            rating: meta.rating || '',
            age: meta.age || '',
            popularity: meta.popularity || 0,
            seasonsMap: {}
          };
          if (meta.tmdbId) {
            atual.tmdbId = meta.tmdbId;
            atual.tmdbTipo = 'tv';
          }
        } else if (atual) {
          if (!atual.tmdbId) {
            const tidEp = extrairTmdbIdDaLinha(l);
            if (tidEp) { atual.tmdbId = tidEp; atual.tmdbTipo = 'tv'; }
          }
          const c = l.split('\t');
          if (c.length >= 4) {
            const tNum = parseInt(c[0], 10) || 1;
            const eNum = parseInt(c[1], 10) || 1;
            const idm = c[2].trim().toLowerCase() === 'leg' ? 'legendado' : 'dublado';
            if (!atual.seasonsMap[tNum]) atual.seasonsMap[tNum] = [];
            let ep = atual.seasonsMap[tNum].find((x) => x.episode === eNum);
            if (!ep) { ep = { season: tNum, episode: eNum, fontes: [] }; atual.seasonsMap[tNum].push(ep); }
            for (const u of c[3].split(',')) {
              const fObj = montarFonteComQualidade(u, idm, bases, marcasMap);
              if (fObj) ep.fontes.push(fObj);
            }
          }
        }
      }
      fechar();
    }
  }

  return { filmesCartoonzine, seriesCartoonzine };
}

async function coletarRedeFlix(caminho, catLabel, tipoMeta, bases, buscarMeta, marcasMap, latenciasHost) {
  console.log(`\n✨ Extraindo ${catLabel}...`);
  const txt = await fetchText(`${FILMES_BASE_URL}/${caminho}`);
  if (!txt) return [];
  const listaFinal = [];
  let atual = null;

  const fechar = () => {
    if (!atual) return;
    atual.seasons = Object.keys(atual.seasonsMap).sort((a, b) => Number(a) - Number(b)).map((s) => ({
      season: parseInt(s, 10),
      episodes: atual.seasonsMap[s].map((ep) => ({ ...ep, fontes: ordenarELimparFontesDoItem(ep.fontes, latenciasHost) })).filter((ep) => ep.fontes.length > 0).sort((a, b) => a.episode - b.episode)
    })).filter((s) => s.episodes.length > 0);
    delete atual.seasonsMap;
    if (atual.seasons.length > 0) listaFinal.push(atual);
  };

  for (let l of txt.split(/\r?\n/)) {
    l = l.trim();
    if (!l || isCommentLine(l)) continue;
    if (l.startsWith('@')) {
      fechar();
      const c = l.slice(1).split('\t');
      const titBruto = (c[0] || '').trim();
      const titLimpo = limparTituloExibicao(titBruto);
      const anoItem = (c[1] || '').trim() || extrairAnoDoTitulo(titBruto);
      const tidCab = (/^\d+$/.test((c[2] || '').trim()) ? Number(c[2].trim()) : null);
      const meta = buscarMeta(tipoMeta, titBruto, anoItem, tidCab);
      const genresArr = (meta.genres && meta.genres.length > 0) ? meta.genres : [catLabel];

      atual = {
        cat: catLabel,
        title: titLimpo,
        desc: meta.desc || '',
        thumb: meta.thumb || '',
        bannerThumb: meta.bannerThumb || '',
        logo: '',
        bannerlogo: '',
        year: anoItem || meta.year || '',
        genre: genresArr.join(', '),
        genres: genresArr,
        rating: meta.rating || '',
        age: meta.age || '',
        popularity: meta.popularity || 0,
        seasonsMap: {}
      };
      if (catLabel === 'Animes') atual.anime = true;
      const tid = tidCab || meta.tmdbId;
      if (tid) { atual.tmdbId = tid; atual.tmdbTipo = 'tv'; }
    } else if (atual) {
      const c = l.split('\t');
      if (c.length >= 4) {
        const tNum = parseInt(c[0], 10) || 1;
        const eNum = parseInt(c[1], 10) || 1;
        const idm = c[2].trim().toLowerCase() === 'leg' ? 'legendado' : 'dublado';
        if (!atual.seasonsMap[tNum]) atual.seasonsMap[tNum] = [];
        let ep = atual.seasonsMap[tNum].find((x) => x.episode === eNum);
        if (!ep) { ep = { season: tNum, episode: eNum, fontes: [] }; atual.seasonsMap[tNum].push(ep); }
        for (const u of c[3].split(',')) {
          const fObj = montarFonteComQualidade(u, idm, bases, marcasMap);
          if (fObj) ep.fontes.push(fObj);
        }
      }
    }
  }
  fechar();
  return listaFinal;
}

async function processarDestaques(destaquesTxt, buscarMeta, tmdbCache) {
  if (!destaquesTxt) return;
  let capaBase = 'https://image.tmdb.org/t/p/w342';
  const destaques = [];
  let fila = null;

  for (let l of destaquesTxt.split(/\r?\n/)) {
    l = l.trim();
    if (!l || isCommentLine(l)) continue;
    if (l.startsWith('capa:')) { capaBase = l.replace('capa:', '').trim(); continue; }
    const c = l.split('\t');
    if (c[0] === 'fila' && c.length >= 2) {
      fila = { titulo: c[1], itens: [] };
      destaques.push(fila);
    } else if (fila && ['f', 's', 'a', 'd'].includes(c[0]) && c.length >= 5) {
      const tit = limparTituloExibicao(c[1]);
      const anoD = (c[3] || '').trim();
      const meta = buscarMeta(c[0], c[1], anoD);
      const cached = meta.tmdbId ? tmdbCache[`${c[0] === 'f' ? 'movie' : 'tv'}_${meta.tmdbId}`] : null;
      const logoUrl = (cached && cached.logo) || '';
      fila.itens.push({
        tipo: c[0] === 'f' ? 'Filme' : c[0] === 's' ? 'Série' : c[0] === 'a' ? 'Anime' : 'Dorama',
        titulo: tit,
        ano: anoD || meta.year || '',
        genre: meta.genre || '',
        rating: meta.rating || '',
        age: meta.age || '',
        capa: c[4] ? (c[4].startsWith('http') ? c[4] : capaBase + c[4]) : '',
        bannerThumb: (cached && cached.backdrop) || '',
        logo: logoUrl,
        bannerlogo: logoUrl
      });
    }
  }
  if (destaques.length > 0) saveJsonFile('destaques_sm.json', destaques);
}

/**
 * 5. GERA O JSON EXCLUSIVO DE METADADOS E FILTROS DE BUSCA (metadados_busca_sm.json)
 */
function gerarJsonMetadadosBusca(filmes, series, animes, doramas) {
  console.log('\n🔎 Gerando JSON exclusivo de Metadados para Filtros de Busca (metadados_busca_sm.json)...');

  const contagemGeneros = new Map();
  const contagemAnos = new Map();
  const contagemIdades = new Map();
  const contagemIdiomas = { dublado: 0, legendado: 0 };
  const contagemQualidades = { '4K': 0, FHD: 0, HD: 0, SD: 0 };

  const catalogoIndice = [];
  const todosItens = [...filmes, ...series, ...animes, ...doramas];

  let seqId = 0;
  for (const item of todosItens) {
    seqId++;
    const generosItem = Array.isArray(item.genres) && item.genres.length > 0
      ? item.genres
      : parseGenerosLista(item.genre, item.cat);

    for (const g of generosItem) {
      contagemGeneros.set(g, (contagemGeneros.get(g) || 0) + 1);
    }

    if (item.year && /^\d{4}$/.test(String(item.year))) {
      contagemAnos.set(String(item.year), (contagemAnos.get(String(item.year)) || 0) + 1);
    }

    if (item.age) {
      contagemIdades.set(String(item.age), (contagemIdades.get(String(item.age)) || 0) + 1);
    }

    // Inspeciona idiomas e qualidade máxima disponíveis nas fontes do filme ou episódios da série
    const idiomasSet = new Set();
    let qualidadeMax = '';
    const rankQual = { '4K': 4, FHD: 3, HD: 2, SD: 1, '': 0 };

    const inspecionarFonte = (f) => {
      if (!f) return;
      if (f.idioma) idiomasSet.add(f.idioma);
      const q = (f.qualidade || '').toUpperCase();
      if (rankQual[q] > rankQual[qualidadeMax]) qualidadeMax = q;
    };

    if (Array.isArray(item.fontes)) {
      item.fontes.forEach(inspecionarFonte);
    } else if (Array.isArray(item.seasons)) {
      item.seasons.forEach((s) => (s.episodes || []).forEach((ep) => (ep.fontes || []).forEach(inspecionarFonte)));
    }

    const idiomasArr = Array.from(idiomasSet);
    if (idiomasSet.has('dublado')) contagemIdiomas.dublado++;
    if (idiomasSet.has('legendado')) contagemIdiomas.legendado++;
    if (qualidadeMax && contagemQualidades[qualidadeMax] !== undefined) {
      contagemQualidades[qualidadeMax]++;
    }

    const metaEntry = {
      id: seqId,
      cat: item.cat,
      title: item.title,
      year: item.year || '',
      genre: generosItem.join(', '),
      genres: generosItem,
      rating: item.rating || '',
      age: item.age || '',
      popularity: item.popularity || 0,
      idiomas: idiomasArr,
      qualidadeMax: qualidadeMax || 'HD',
      thumb: item.thumb || '',
      logo: item.logo || '',
      tmdbId: item.tmdbId || null
    };

    if (item.seasons) {
      metaEntry.totalSeasons = item.seasons.length;
    }

    catalogoIndice.push(metaEntry);
  }

  // Ordena facetas para usar direto nos dropdowns/botões de filtro
  const generosFacet = Array.from(contagemGeneros.entries())
    .map(([nome, total]) => ({ nome, total }))
    .sort((a, b) => b.total - a.total || a.nome.localeCompare(b.nome, 'pt-BR'));

  const anosFacet = Array.from(contagemAnos.entries())
    .map(([ano, total]) => ({ ano, total }))
    .sort((a, b) => Number(b.ano) - Number(a.ano));

  const classificacoesFacet = Array.from(contagemIdades.entries())
    .map(([classificacao, total]) => ({ classificacao, total }))
    .sort((a, b) => b.total - a.total);

  // Top 100 Rankings para vitrines rápidas de busca/filtro
  const resumirCard = (x) => ({
    cat: x.cat,
    title: x.title,
    year: x.year,
    genre: x.genre,
    rating: x.rating,
    age: x.age,
    popularity: x.popularity,
    thumb: x.thumb,
    logo: x.logo,
    tmdbId: x.tmdbId
  });

  const emAlta = [...catalogoIndice]
    .filter((x) => x.genre !== 'Adulto' && x.age !== '18')
    .sort((a, b) => (b.popularity - a.popularity) || (parseFloat(b.rating || 0) - parseFloat(a.rating || 0)))
    .slice(0, 100)
    .map(resumirCard);

  const lancamentos2026 = [...catalogoIndice]
    .filter((x) => x.year === '2026' && x.genre !== 'Adulto')
    .sort((a, b) => (b.popularity - a.popularity) || (parseFloat(b.rating || 0) - parseFloat(a.rating || 0)))
    .slice(0, 100)
    .map(resumirCard);

  const melhoresAvaliados = [...catalogoIndice]
    .filter((x) => parseFloat(x.rating || 0) >= 7.5 && x.popularity >= 3 && x.genre !== 'Adulto')
    .sort((a, b) => (parseFloat(b.rating || 0) - parseFloat(a.rating || 0)) || (b.popularity - a.popularity))
    .slice(0, 100)
    .map(resumirCard);

  const payloadMetadados = {
    atualizadoEm: new Date().toISOString(),
    filtrosDisponiveis: {
      categorias: [
        { nome: 'Filmes', total: filmes.length },
        { nome: 'Séries', total: series.length },
        { nome: 'Animes', total: animes.length },
        { nome: 'Doramas', total: doramas.length }
      ],
      generos: generosFacet,
      anos: anosFacet,
      classificacoes: classificacoesFacet,
      idiomas: contagemIdiomas,
      qualidades: contagemQualidades
    },
    rankings: {
      emAlta,
      lancamentos2026,
      melhoresAvaliados
    },
    catalogoIndice
  };

  const fullPath = path.join(OUTPUT_DIR, 'metadados_busca_sm.json');
  fs.writeFileSync(fullPath, JSON.stringify(payloadMetadados, null, 2), 'utf-8');
  console.log(`  [✓] listas/metadados_busca_sm.json salvo (${catalogoIndice.length.toLocaleString('pt-BR')} itens indexados e ${generosFacet.length} gêneros mapeados)`);
}

function saveJsonFile(filename, items) {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, filename), JSON.stringify(items, null, 2), 'utf-8');
  console.log(`  [✓] listas/${filename} salvo (${items.length.toLocaleString('pt-BR')} registros)`);
}

(async () => {
  try {
    await processarCanais();
    const { bases, gavetas, buscarMeta, marcasMap, latenciasHost, destaquesTxt } = await carregarMetadadosVOD();
    const { filmesCartoonzine, seriesCartoonzine } = await coletarVOD(bases, gavetas, buscarMeta, marcasMap, latenciasHost);
    const animes = await coletarRedeFlix('redeflix/links-animes.txt', 'Animes', 'a', bases, buscarMeta, marcasMap, latenciasHost);
    const doramas = await coletarRedeFlix('redeflix/links-doramas.txt', 'Doramas', 'd', bases, buscarMeta, marcasMap, latenciasHost);

    const tmdbCache = loadTmdbCache();
    await enrichItemsWithTmdbLogos([...doramas, ...animes, ...seriesCartoonzine, ...filmesCartoonzine], tmdbCache);

    saveJsonFile('filmes_sm.json', filmesCartoonzine);
    const tam = Math.ceil(seriesCartoonzine.length / 3) || 0;
    saveJsonFile('series_sm_pt1.json', seriesCartoonzine.slice(0, tam));
    saveJsonFile('series_sm_pt2.json', seriesCartoonzine.slice(tam, tam * 2));
    saveJsonFile('series_sm_pt3.json', seriesCartoonzine.slice(tam * 2));
    saveJsonFile('animes_sm.json', animes);
    saveJsonFile('doramas_sm.json', doramas);

    await processarDestaques(destaquesTxt, buscarMeta, tmdbCache);
    gerarJsonMetadadosBusca(filmesCartoonzine, seriesCartoonzine, animes, doramas);

    console.log('\n✅ TUDO CONCLUÍDO COM SUCESSO (CATÁLOGO + METADADOS DE BUSCA GERADOS)!');
  } catch (err) {
    console.error('❌ Erro fatal:', err);
    process.exit(1);
  }
})();
