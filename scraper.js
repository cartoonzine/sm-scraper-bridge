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
const MAX_TMDB_FETCH_PER_RUN = 5000;
const TMDB_CONCURRENCY = 30;

const http = axios.create({
  timeout: 25000,
  headers: { 'User-Agent': DEFAULT_UA, 'Accept': 'text/plain, application/json, */*' },
  responseType: 'text',
  transformResponse: [(d) => d]
});

async function fetchText(url) {
  try {
    const res = await http.get(url);
    return (res.status >= 200 && res.status < 300 && typeof res.data === 'string') ? res.data : '';
  } catch (_) {
    return '';
  }
}

/**
 * Normaliza o título MAS PRESERVA O ANO quando solicitado, para nunca misturar
 * remakes ou filmes de 2026 com filmes antigos de mesmo nome!
 */
function normalizarTexto(str) {
  return String(str || '')
    .replace(/\s*\[(4k|uhd|fhd|1080p|720p|hd|sd|dub|leg)\]\s*/gi, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function extrairAnoDoTitulo(titulo) {
  const m = String(titulo || '').match(/\((\d{4})\)\s*$/);
  return m ? m[1] : '';
}

function limparTituloExibicao(titulo) {
  return String(titulo || '')
    .replace(/\s*\(\d{4}\)\s*$/g, '')
    .replace(/\s*\[(4k|uhd|fhd|1080p|720p|hd|sd|dub|leg)\]\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSaimoApiUrl(url) {
  const low = String(url || '').toLowerCase();
  return low.includes('saimo-tv.pages.dev/api/') || low.includes('/api/stream');
}

function normalizeHlsUrl(rawUrl, referer = '', userAgent = '') {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let u = rawUrl.trim();
  if (!u.startsWith('http://') && !u.startsWith('https://')) return null;
  if (isSaimoApiUrl(u)) return null;

  const low = u.toLowerCase().split('?')[0];

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

/**
 * Caso um lançamento de 2026 tenha APENAS link da API Saimo (saimo-tv.pages.dev/api/stream),
 * resolve a API em background para extrair o link .mp4 ou .m3u8 verdadeiro!
 */
async function resolverLinkApiSaimo(apiUrl) {
  try {
    const res = await axios.get(apiUrl, {
      timeout: 6000,
      maxRedirects: 0,
      validateStatus: (s) => s >= 200 && s < 400,
      headers: { 'User-Agent': DEFAULT_UA, 'Referer': 'https://saimotv.com/' }
    });
    if (res.headers && res.headers.location && !isSaimoApiUrl(res.headers.location)) {
      return normalizeHlsUrl(res.headers.location);
    }
    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    const realUrl = data && (data.url || data.stream || data.file || data.src || ( Array.isArray(data.sources) && data.sources[0] ));
    if (realUrl && typeof realUrl === 'string' && !isSaimoApiUrl(realUrl)) {
      return normalizeHlsUrl(realUrl);
    }
  } catch (_) {}
  return null;
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
  let score = pontosQualidade(fonteObj.qualidade, url) * 10;

  if (url.includes('play.saimotv.com/api/proxy')) score += 150;
  else if (url.includes('master.txt') || url.includes('format=m3u8')) score += 350;
  else if (/\.(mp4|mkv|m4v|webm)(\?|$)/i.test(url)) score += 800;
  else if (/\.m3u8(\?|$)/i.test(url)) score += 700;
  else score += 500;

  try {
    const host = new URL(url).host;
    const ms = latenciasHost ? (latenciasHost.get(host) ?? 500) : 500;
    score += ms >= 9000 ? -1500 : Math.max(0, 400 - Math.round(ms / 10));
  } catch (_) {}

  if (fonteObj.idioma === 'dublado') score += 50;
  return score;
}

function unificarEOrdenarFontes(listaFontes, latenciasHost) {
  const mapa = new Map();
  for (const f of listaFontes) {
    if (!f || !f.url) continue;
    const ex = mapa.get(f.url);
    if (!ex) mapa.set(f.url, { ...f });
    else if (!ex.qualidade && f.qualidade) ex.qualidade = f.qualidade;
  }
  const unicas = Array.from(mapa.values());
  unicas.sort((a, b) => calcularScoreFonte(b, latenciasHost) - calcularScoreFonte(a, latenciasHost));
  return unicas.map((f) => {
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

  if (limpo.startsWith('http://') || limpo.startsWith('https://')) {
    const urlFinal = normalizeHlsUrl(limpo);
    return urlFinal ? { url: urlFinal, idioma, qualidade: qualidadeMarca } : null;
  }

  const partes = limpo.split(':');
  if (partes.length < 2) return null;
  const base = bases[partes[0].trim()];
  const resto = partes.slice(1).join(':').trim();
  if (!base || !resto) return null;

  const baseFmt = base.endsWith('/') ? base : `${base}/`;
  const urlCrua = resto.includes('.') ? `${baseFmt}${resto}` : `${baseFmt}${resto}.mp4`;
  const urlFinal = normalizeHlsUrl(urlCrua);
  return urlFinal ? { url: urlFinal, idioma, qualidade: qualidadeMarca } : null;
}

function extrairFontes(campos, bases, marcasMap, latenciasHost) {
  const fontes = [];
  const apisReserva = [];

  for (let i = 1; i < campos.length; i++) {
    const campo = (campos[i] || '').trim();
    if (!campo) continue;

    const temIgual = campo.includes('=');
    const prefixo = temIgual ? campo.slice(0, campo.indexOf('=')).toLowerCase().trim() : 'dub';
    const resto = temIgual ? campo.slice(campo.indexOf('=') + 1).trim() : campo;
    const idioma = (prefixo === 'leg' || prefixo.includes('leg')) ? 'legendado' : 'dublado';

    for (const urlBruta of resto.split(',')) {
      const uTrim = urlBruta.trim();
      if (isSaimoApiUrl(uTrim)) {
        apisReserva.push({ apiUrl: uTrim, idioma });
        continue;
      }
      const fObj = montarFonteComQualidade(uTrim, idioma, bases, marcasMap);
      if (fObj) fontes.push(fObj);
    }
  }
  return { fontes: unificarEOrdenarFontes(fontes, latenciasHost), apisReserva };
}

function mesclarTemporadas(seasonsA = [], seasonsB = [], latenciasHost) {
  const mapaTemp = new Map();
  const add = (lista) => {
    for (const s of lista) {
      const sNum = parseInt(s.season, 10) || 1;
      if (!mapaTemp.has(sNum)) mapaTemp.set(sNum, new Map());
      const mapaEp = mapaTemp.get(sNum);
      for (const ep of (s.episodes || [])) {
        const epNum = parseInt(ep.episode, 10) || 1;
        if (!mapaEp.has(epNum)) mapaEp.set(epNum, []);
        mapaEp.get(epNum).push(...(ep.fontes || []));
      }
    }
  };
  add(seasonsA);
  add(seasonsB);

  return Array.from(mapaTemp.keys())
    .sort((a, b) => a - b)
    .map((sNum) => {
      const mapaEp = mapaTemp.get(sNum);
      const episodes = Array.from(mapaEp.keys())
        .sort((a, b) => a - b)
        .map((epNum) => ({
          season: sNum,
          episode: epNum,
          fontes: unificarEOrdenarFontes(mapaEp.get(epNum), latenciasHost)
        }))
        .filter((ep) => ep.fontes.length > 0);
      return { season: sNum, episodes };
    })
    .filter((s) => s.episodes.length > 0);
}

/**
 * Unifica APENAS títulos que tenham exatamente o mesmo nome E o mesmo ano!
 * Assim "Street Fighter (2026)" NUNCA é engolido por "Street Fighter (1994)".
 * E ordena os mais recentes (2026 -> 2025 -> ...) para o início!
 */
function unificarEOrdenarCatalogo(itens, latenciasHost, isSerie = false) {
  const mapaUnico = new Map();
  let fundidos = 0;

  for (const item of itens) {
    const tituloLimpo = limparTituloExibicao(item.title);
    const chaveTexto = normalizarTexto(tituloLimpo);
    if (!chaveTexto) continue;

    // A chave SEMPRE inclui o título normalizado + ano para jamais fundir remakes ou continuações!
    const chave = `${chaveTexto}_${item.year || 's_ano'}`;

    if (!mapaUnico.has(chave)) {
      const copia = { ...item, title: tituloLimpo };
      if (isSerie) copia.seasons = mesclarTemporadas(item.seasons || [], [], latenciasHost);
      else copia.fontes = unificarEOrdenarFontes(item.fontes || [], latenciasHost);
      mapaUnico.set(chave, copia);
    } else {
      fundidos++;
      const ex = mapaUnico.get(chave);
      if (!ex.thumb && item.thumb) ex.thumb = item.thumb;
      if (!ex.bannerThumb && item.bannerThumb) ex.bannerThumb = item.bannerThumb;
      if (!ex.desc && item.desc) ex.desc = item.desc;
      if (!ex.tmdbId && item.tmdbId) { ex.tmdbId = item.tmdbId; ex.tmdbTipo = item.tmdbTipo; }

      if (isSerie) ex.seasons = mesclarTemporadas(ex.seasons, item.seasons, latenciasHost);
      else ex.fontes = unificarEOrdenarFontes([...(ex.fontes || []), ...(item.fontes || [])], latenciasHost);
    }
  }

  if (fundidos > 0) console.log(`  [♻️ Unificação] ${fundidos} cópias idênticas fundidas como reserva!`);

  const resultado = Array.from(mapaUnico.values());
  // Coloca os lançamentos (2026, 2025...) no topo da lista, seguido de ordem alfabética
  resultado.sort((a, b) => {
    const anoA = parseInt(a.year || '0', 10) || 0;
    const anoB = parseInt(b.year || '0', 10) || 0;
    if (anoB !== anoA) return anoB - anoA;
    return String(a.title || '').localeCompare(String(b.title || ''), 'pt-BR');
  });

  return resultado;
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
    return {
      logo: logo && logo.file_path ? `${TMDB_IMG_LOGO}${logo.file_path}` : '',
      backdrop: d.backdrop_path ? `${TMDB_IMG_BACKDROP}${d.backdrop_path}` : '',
      poster: d.poster_path ? `${TMDB_IMG_POSTER}${d.poster_path}` : '',
      desc: (d.overview || '').trim()
    };
  } catch (_) {
    return null;
  }
}

async function enrichItemsWithTmdbLogos(allItems, tmdbCache) {
  const fila = [];
  for (const it of allItems) {
    if (!it.tmdbId || !it.tmdbTipo) continue;
    const k = `${it.tmdbTipo}_${it.tmdbId}`;
    if (!tmdbCache[k]) fila.push({ key: k, tmdbId: it.tmdbId, tmdbTipo: it.tmdbTipo });
  }
  const unicos = Array.from(new Map(fila.map((x) => [x.key, x])).values()).slice(0, MAX_TMDB_FETCH_PER_RUN);

  if (unicos.length > 0) {
    console.log(`\n🎨 Buscando Logos PNG e Backdrops no TMDB para ${unicos.length} títulos (priorizando 2026)...`);
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
      if (cached.desc) it.desc = cached.desc;
    }
  }
}

function classificarCanal(nome) {
  const n = String(nome || '').toLowerCase();
  if (/(sexy hot|playboy|adulto|venus|hustler|private|sex)/.test(n)) return 'Adulto';
  if (/(pluto)/.test(n)) return 'Pluto TV';
  if (/(espn|sportv|premiere|combate|band sports|cazé|caze|nsports|xsports|ufc|paramount\+|dazn|nosso futebol|goat)/.test(n)) return 'Esportes';
  if (/(news|globonews|cnn|record news|jovem pan|terra viva|bandnews)/.test(n)) return 'Notícias';
  if (/(cartoon|nick|discovery kids|gloob|infantil|kids|boomerang|tooncast|ra tim bum|disney|dreamworks)/.test(n)) return 'Infantil';
  if (/(discovery|history|animal planet|natgeo|national geographic|investigação|curta!|smithsonian)/.test(n)) return 'Documentários';
  if (/(hbo|telecine|megapix|paramount|tnt|space|universal|amc|cinemax|star|axn|sony|warner|studio|syfy|usa|prime video)/.test(n)) return 'Filmes e Séries';
  if (/(globo|sbt|record|band|rede tv|redetv|cultura|gazeta|futura|tv brasil|aparecida|cancao nova)/.test(n)) return 'TV Aberta';
  return 'Variedades';
}

/**
 * 1. CANAIS: Lê catalogo.txt + canais.txt + restritos.txt sem engolir canais numerados (ESPN 2, 3, 4) ou regionais!
 */
async function processarCanais() {
  console.log('\n📺 1. Baixando todos os canais (catalogo.txt + canais.txt + restritos.txt)...');
  const [catalogoTxt, canaisM3uTxt, restritosTxt] = await Promise.all([
    fetchText(`${CANAIS_BASE_URL}/catalogo.txt`),
    fetchText(`${CANAIS_BASE_URL}/canais.txt`),
    fetchText(`${CANAIS_BASE_URL}/restritos.txt`)
  ]);

  const canaisMap = new Map();
  let canalAtual = null;
  let ultimaFonte = null;

  // Preserva números e estados (SP, RJ, 2, 3...) removendo apenas sufixo "HD" solto no final
  const chaveCanal = (n) =>
    String(n || '')
      .toLowerCase()
      .replace(/\s+hd$/i, '')
      .replace(/\s+/g, ' ')
      .trim();

  const parseFormatoCatalogo = (texto, categoriaForcada = '') => {
    for (let linha of (texto || '').split(/\r?\n/)) {
      linha = linha.trim();
      if (!linha || linha.startsWith('#')) continue;
      const partes = linha.split(':');
      if (partes.length < 2) continue;
      const k = partes.shift().trim().toLowerCase();
      const v = partes.join(':').trim();
      if (!v) continue;

      if (k === 'canal') {
        ultimaFonte = null;
        const nk = chaveCanal(v);
        if (!canaisMap.has(nk)) {
          canalAtual = {
            nome: v,
            logo: '',
            categoria: categoriaForcada || classificarCanal(v),
            fontesBrutas: []
          };
          canaisMap.set(nk, canalAtual);
        } else {
          canalAtual = canaisMap.get(nk);
        }
      } else if (canalAtual && k === 'logo' && !canalAtual.logo) {
        canalAtual.logo = v;
      } else if (canalAtual && k === 'categoria' && !categoriaForcada) {
        canalAtual.categoria = v;
      } else if (canalAtual && k === 'fonte') {
        ultimaFonte = !isSaimoApiUrl(v) ? { rawUrl: v, referer: '', ua: '', qualidade: '' } : null;
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

  parseFormatoCatalogo(catalogoTxt);
  parseFormatoCatalogo(restritosTxt, 'Adulto');

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
      } else if (!l.startsWith('#') && pend && !isSaimoApiUrl(l)) {
        const nk = chaveCanal(pend.nome);
        if (canaisMap.has(nk)) {
          const c = canaisMap.get(nk);
          c.fontesBrutas.push({ rawUrl: l, referer: '', ua: '', qualidade: '' });
          if (!c.logo && pend.logo) c.logo = pend.logo;
        } else if (pend.nome) {
          canaisMap.set(nk, {
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
  for (const c of canaisMap.values()) {
    const conv = c.fontesBrutas
      .map((f) => ({ url: normalizeHlsUrl(f.rawUrl, f.referer, f.ua), idioma: 'dublado', qualidade: f.qualidade }))
      .filter((f) => f.url);
    const ord = unificarEOrdenarFontes(conv, null).sort((a, b) => {
      const aFb = a.url.includes('fallback') || a.url.includes('play.saimotv.com/api/proxy');
      const bFb = b.url.includes('fallback') || b.url.includes('play.saimotv.com/api/proxy');
      return aFb === bFb ? 0 : (aFb ? 1 : -1);
    });
    if (ord.length > 0) {
      id++;
      out.push({ id: String(id), nome: c.nome, categoria: c.categoria, logo: c.logo, urls: ord.map((x) => x.url) });
    }
  }
  saveJsonFile('canais_sm.json', out);
}

/**
 * 2. CARREGA METADADOS DO ACERVO PRESERVANDO TÍTULO EXATO E ANO
 */
async function carregarMetadadosVOD() {
  console.log('\n🎬 2. Carregando índice, fichas, detalhes e marcas.txt...');
  const [indiceTxt, fichasTxt, generosTxt, detalhesTxt, marcasTxt] = await Promise.all([
    fetchText(`${FILMES_BASE_URL}/indice.txt`),
    fetchText(`${FILMES_BASE_URL}/fichas.txt`),
    fetchText(`${FILMES_BASE_URL}/generos.txt`),
    fetchText(`${FILMES_BASE_URL}/detalhes.txt`),
    fetchText(`${FILMES_BASE_URL}/marcas.txt`)
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
      if (c[0]) gavetas.push({ letra: c[0].trim(), filmes: parseInt(c[1] || '0', 10), series: parseInt(c[2] || '0', 10) });
    }
  }

  const marcasMap = new Map();
  for (let l of (marcasTxt || '').split(/\r?\n/)) {
    const c = l.trim().split('\t');
    if (c.length >= 2 && !c[0].startsWith('#')) marcasMap.set(c[0].trim(), c[1].trim().toLowerCase());
  }

  // Mapa exato com o título completo (incluindo "(2026)") + fallback sem ano
  const metaMapExato = new Map();
  const metaMapSemAno = new Map();

  const chaveExata = (tipo, tit) => `${tipo.toLowerCase()}|${ String(tit || '').trim().toLowerCase() }`;
  const chaveSemAno = (tipo, tit) => `${tipo.toLowerCase()}|${ normalizarTexto(limparTituloExibicao(tit)) }`;

  const getOrInit = (tipo, tit) => {
    const ke = chaveExata(tipo, tit);
    const ks = chaveSemAno(tipo, tit);
    if (!metaMapExato.has(ke)) {
      const novo = { tipoOriginal: tipo.toLowerCase(), tmdbId: '', thumb: '', bannerThumb: '', genre: '', year: extrairAnoDoTitulo(tit), desc: '' };
      metaMapExato.set(ke, novo);
      // No mapa sem ano, prioriza guardar o mais recente (ex: 2026)
      const existenteSemAno = metaMapSemAno.get(ks);
      if (!existenteSemAno || (novo.year && novo.year >= (existenteSemAno.year || ''))) {
        metaMapSemAno.set(ks, novo);
      }
    }
    return metaMapExato.get(ke);
  };

  for (let l of (fichasTxt || '').split(/\r?\n/)) {
    l = l.trim();
    if (!l || l.startsWith('#') || l.startsWith('capa:')) continue;
    const c = l.split('\t');
    if (c.length >= 4) {
      const m = getOrInit(c[0], c[1]);
      if (c[2] && /^\d+$/.test(c[2].trim())) m.tmdbId = Number(c[2].trim());
      if (c[3]) {
        const img = c[3].startsWith('http') ? c[3] : `${TMDB_IMG_POSTER}${c[3].startsWith('/') ? '' : '/'}${c[3]}`;
        m.thumb = img; m.bannerThumb = img;
      }
      if (c[4]) m.genre = c[4].split(',')[0].trim();
    }
  }

  for (let l of (generosTxt || '').split(/\r?\n/)) {
    const c = l.trim().split('\t');
    if (c.length >= 3 && !c[0].startsWith('#')) {
      const m = getOrInit(c[0], c[1]);
      if (!m.genre && c[2]) m.genre = c[2].split(',')[0].trim();
    }
  }

  for (let l of (detalhesTxt || '').split(/\r?\n/)) {
    const c = l.trim().split('\t');
    if (c.length >= 3 && !c[0].startsWith('#')) {
      const m = getOrInit(c[0], c[1]);
      if (c[2]) m.year = c[2].trim();
    }
  }

  const buscarMeta = (tipo, tituloBruto, anoOpcional = '') => {
    const t = tipo.toLowerCase();
    const comAno = anoOpcional && !tituloBruto.includes(`(${anoOpcional})`) ? `${tituloBruto} (${anoOpcional})` : tituloBruto;
    return (
      metaMapExato.get(chaveExata(t, tituloBruto)) ||
      metaMapExato.get(chaveExata(t, comAno)) ||
      metaMapExato.get(chaveExata('a', tituloBruto)) ||
      metaMapExato.get(chaveExata('d', tituloBruto)) ||
      metaMapSemAno.get(chaveSemAno(t, tituloBruto)) ||
      {}
    );
  };

  const latenciasHost = await medirVelocidadeBases(bases);
  return { bases, gavetas, buscarMeta, marcasMap, latenciasHost };
}

/**
 * 3. COLETA TODOS OS FILMES E SÉRIES (Incluindo todas as letras de # e A-Z)
 */
async function coletarVOD(bases, gavetas, buscarMeta, marcasMap, latenciasHost) {
  const filmesBrutos = [];
  const seriesBrutas = [];
  const animesExtrasDasSeries = [];
  const doramasExtrasDasSeries = [];
  const filmesSoComApi = [];

  // Garante varrer TODAS as 27 letras (# e A-Z) mesmo se alguma não estiver listada
  const todasLetras = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];

  console.log('\n🎥 3. Extraindo todos os Filmes (# e A-Z)...');
  const resFilmes = await Promise.all(
    todasLetras.map(async (letra) => {
      const arq = letra === '#' ? '%23' : letra;
      return (await fetchText(`${FILMES_BASE_URL}/filmes-${arq}.txt`)) || (letra === '#' ? await fetchText(`${FILMES_BASE_URL}/filmes-#.txt`) : '');
    })
  );

  for (const txt of resFilmes) {
    for (let l of (txt || '').split(/\r?\n/)) {
      l = l.trim();
      if (!l || l.startsWith('#')) continue;
      const c = l.split('\t');
      if (c.length < 2 || !c[0]) continue;

      const tituloBruto = c[0].trim();
      const anoNoTitulo = extrairAnoDoTitulo(tituloBruto);
      const { fontes, apisReserva } = extrairFontes(c, bases, marcasMap, latenciasHost);

      const meta = buscarMeta('f', tituloBruto, anoNoTitulo);
      const obj = {
        cat: 'Filmes',
        title: limparTituloExibicao(tituloBruto),
        desc: meta.desc || '',
        thumb: meta.thumb || '',
        bannerThumb: meta.bannerThumb || '',
        logo: '',
        bannerlogo: '',
        year: anoNoTitulo || meta.year || '',
        genre: meta.genre || 'Filme',
        fontes
      };
      if (meta.tmdbId) { obj.tmdbId = meta.tmdbId; obj.tmdbTipo = 'movie'; }

      if (fontes.length > 0) {
        filmesBrutos.push(obj);
      } else if (apisReserva.length > 0) {
        filmesSoComApi.push({ obj, apisReserva });
      }
    }
  }

  // Se houver filmes recém-lançados que só tinham link da API Saimo, tenta resolver o link real deles!
  if (filmesSoComApi.length > 0) {
    console.log(`  [🔍 Resgate 2026] ${filmesSoComApi.length} filmes tinham apenas API. Tentando extrair link direto...`);
    const LOTE_API = 25;
    for (let i = 0; i < Math.min(filmesSoComApi.length, 300); i += LOTE_API) {
      const slice = filmesSoComApi.slice(i, i + LOTE_API);
      await Promise.all(slice.map(async ({ obj, apisReserva }) => {
        for (const apiItem of apisReserva) {
          const realUrl = await resolverLinkApiSaimo(apiItem.apiUrl);
          if (realUrl) {
            obj.fontes.push({ url: realUrl, idioma: apiItem.idioma });
          }
        }
        if (obj.fontes.length > 0) filmesBrutos.push(obj);
      }));
    }
  }

  console.log('\n📺 4. Extraindo todas as Séries (# e A-Z)...');
  for (const letra of todasLetras) {
    const arq = letra === '#' ? '%23' : letra;
    const idxTxt = (await fetchText(`${FILMES_BASE_URL}/series-${arq}.txt`)) || (letra === '#' ? await fetchText(`${FILMES_BASE_URL}/series-#.txt`) : '');
    if (!idxTxt) continue;

    const pedacos = new Set();
    for (const l of idxTxt.split(/\r?\n/)) {
      const c = l.split('\t');
      if (c.length >= 3 && c[2]) pedacos.add(c[2].trim());
    }

    const textosPedacos = await Promise.all(
      Array.from(pedacos).map(async (p) => (await fetchText(`${FILMES_BASE_URL}/series-${arq}-${p}.txt`)) || (letra === '#' ? await fetchText(`${FILMES_BASE_URL}/series-#-${p}.txt`) : ''))
    );

    for (const txt of textosPedacos) {
      let atual = null;
      let tipoOriginalMeta = 's';

      const fechar = () => {
        if (!atual) return;
        atual.seasons = Object.keys(atual.seasonsMap).sort((a, b) => Number(a) - Number(b)).map((s) => ({
          season: parseInt(s, 10),
          episodes: atual.seasonsMap[s].map((ep) => ({ ...ep, fontes: unificarEOrdenarFontes(ep.fontes, latenciasHost) })).filter((ep) => ep.fontes.length > 0).sort((a, b) => a.episode - b.episode)
        })).filter((s) => s.episodes.length > 0);
        delete atual.seasonsMap;

        if (atual.seasons.length > 0) {
          if (tipoOriginalMeta === 'a') {
            animesExtrasDasSeries.push({ ...atual, cat: 'Animes', anime: true });
          } else if (tipoOriginalMeta === 'd') {
            doramasExtrasDasSeries.push({ ...atual, cat: 'Doramas' });
          }
          seriesBrutas.push(atual);
        }
      };

      for (let l of (txt || '').split(/\r?\n/)) {
        l = l.trim();
        if (!l || l.startsWith('#')) continue;
        if (l.startsWith('@')) {
          fechar();
          const c = l.slice(1).split('\t');
          const titBruto = (c[0] || '').trim();
          const anoCab = (c[1] || '').trim();
          const meta = buscarMeta('s', titBruto, anoCab);
          tipoOriginalMeta = meta.tipoOriginal || 's';

          atual = {
            cat: 'Séries',
            title: limparTituloExibicao(titBruto),
            desc: meta.desc || '',
            thumb: meta.thumb || '',
            bannerThumb: meta.bannerThumb || '',
            logo: '',
            bannerlogo: '',
            year: anoCab || meta.year || '',
            genre:Esses quatro exemplos (*Dinheiro Suspeito*, *El despertar*, *Godzilla Minus Zero* e *Street Fighter*) mataram a charada na hora! 

Olha o que esses títulos de 2026 têm em comum e **por que eles estavam no `filmes-saimo.pages.dev` (e em `canais-saimo.pages.dev`) mas sumiram no nosso `scraper.js`**:

### 1. O Assassino Silencioso: `normalizarTituloChave` sem o `(Ano)`!
No nosso último `scraper.js`, a função `carregarMetadadosVOD()` guardava as fichas usando apenas o nome limpo sem o ano:
* Em `filmes-S.txt` existem **vários** filmes chamados *Street Fighter*: `Street Fighter (1994)`, `Street Fighter (2009)` e o novo **`Street Fighter (2026)`**.
* Em `filmes-G.txt` existem vários *Godzilla*, em `filmes-E.txt` vários *El Despertar*...
* Como o `metaMap` removia o `(2026)` do título ao criar a chave (`replace(/\s*\(\d{4}\)\s*$/g, '')`), todos os *Street Fighter* recebiam o **mesmo `tmdbId`** (o do filme antigo de 1994!).
* E logo depois, na função `unificarTitulosRepetidos()`, como ela usava `const chave = item.tmdbId ? "tmdb_" + item.tmdbId : ...`, o **`Street Fighter (2026)` era engolido para dentro do `Street Fighter (1994)`**! Ele sumia como filme próprio de 2026 e virava apenas um link reserva escondido dentro do filme de 1994!

### 2. Os Lançamentos de 2026 que usam `saimo-tv.pages.dev/api/stream` ou `embedplayer2.xyz`
No Saimo TV (tanto no site quanto nos apps), muitos lançamentos quentes de 2026 (como *Godzilla Minus Zero* e *Dinheiro Suspeito*) entram nos arquivos `filmes-D.txt` e `filmes-G.txt` tendo como fonte **apenas** `https://embedplayer2.xyz/cdn/hls/.../master.txt` ou `https://saimo-tv.pages.dev/api/stream?tipo=movie&id=...`[cite: 4].
* Na versão que você tinha rodado antes (quando deu o erro na linha 506), o JSON que estava salvo lá no seu GitHub ainda era da versão anterior que **bloqueava 100% do `embedplayer2.xyz` e `saimo-tv.pages.dev/api/stream`**!
* Quando um filme de 2026 só tinha essa fonte, o `if (!fontes.length) continue;` jogava o filme inteiro no lixo!

### 3. O que faltou em `canais-saimo.pages.dev`: `restritos.txt` e `radios.txt` + Canais com mesmo nome base!
Em `canais-saimo.pages.dev`, nós fizemos uma função `chaveCanal(n)` que removia números ou juntava canais parecidos, e também não estávamos baixando o `restritos.txt` e o `radios.txt`[cite: 6]. Além disso, em Animes e Doramas, no `filmes-saimo.pages.dev`, além de `redeflix/links-animes.txt` e `redeflix/links-doramas.txt`[cite: 6], muitos animes e doramas novos estão dentro de `series-A.txt` a `series-Z.txt` marcados pelo gênero `Animação` / `Anime` / `Dorama` no `fichas.txt` e `generos.txt`[cite: 6]!

---

### Vamos confirmar como estão escritos esses 4 filmes lá no `filmes-saimo.pages.dev` (Teste de 5 segundos)

Enquanto você atualiza o `scraper.js` abaixo, se quiser ver com seus próprios olhos a linha exata de **Dinheiro Suspeito**, **El despertar**, **Godzilla Minus Zero** e **Street Fighter** dentro do `filmes-saimo.pages.dev`, cole este comando no Console (F12) de qualquer aba aberta de `saimotv.com`:

```javascript
(async () => {
  const letras = ['D', 'E', 'G', 'S'];
  const achados = [];
  for (const L of letras) {
    const txt = await fetch(`[https://filmes-saimo.pages.dev/filmes-$](https://filmes-saimo.pages.dev/filmes-$){L}.txt`).then(r => r.text()).catch(() => '');
    const linhas = txt.split('\n').filter(l => /dinheiro suspeito|el despertar|godzilla minus|street fighter/i.test(l));
    achados.push(...linhas);
  }
  console.log("LINHAS REAIS NO FILMES-SAIMO.PAGES.DEV:\n", achados.join('\n\n'));
})();
