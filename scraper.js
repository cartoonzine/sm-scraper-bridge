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
const SAIMO_APP_UA = 'SaimoTV-cliente/3.0.5 libmpv';
const MAX_TMDB_FETCH_PER_RUN = 5500;
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
  if (!u.startsWith('http://') && !u.startsWith('https://')) return null;
  if (isSaimoApiStreamUrl(u)) return null;

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

/**
 * Ordena as fontes dentro do MESMO título (melhor resolução + servidor mais rápido em 1º lugar)
 * sem unificar nem apagar outros títulos do catálogo!
 */
function ordenarFontesDoItem(listaFontes, latenciasHost) {
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
    if (isSaimoApiStreamUrl(limpo)) {
      return { url: limpo, idioma, qualidade: qualidadeMarca, isApiFallback: true };
    }
    const urlFinal = normalizeMediaUrl(limpo);
    return urlFinal ? { url: urlFinal, idioma, qualidade: qualidadeMarca, isApiFallback: false } : null;
  }

  const partes = limpo.split(':');
  if (partes.length < 2) return null;
  const base = bases[partes[0].trim()];
  const resto = partes.slice(1).join(':').trim();
  if (!base || !resto) return null;

  const baseFmt = base.endsWith('/') ? base : `${base}/`;
  const urlCrua = resto.includes('.') ? `${baseFmt}${resto}` : `${baseFmt}${resto}.mp4`;
  if (isSaimoApiStreamUrl(urlCrua)) {
    return { url: urlCrua, idioma, qualidade: qualidadeMarca, isApiFallback: true };
  }
  const urlFinal = normalizeMediaUrl(urlCrua);
  return urlFinal ? { url: urlFinal, idioma, qualidade: qualidadeMarca, isApiFallback: false } : null;
}

function extrairFontes(campos, bases, marcasMap, latenciasHost) {
  const fontesDiretas = [];
  const apiFallbacks = [];

  for (let i = 1; i < campos.length; i++) {
    const campo = (campos[i] || '').trim();
    if (!campo || !campo.includes('=')) continue;
    const idxEq = campo.indexOf('=');
    const prefixo = campo.slice(0, idxEq).toLowerCase().trim();
    const resto = campo.slice(idxEq + 1).trim();
    const idioma = (prefixo === 'leg' || prefixo.includes('leg')) ? 'legendado' : 'dublado';
    for (const urlBruta of resto.split(',')) {
      const fObj = montarFonteComQualidade(urlBruta, idioma, bases, marcasMap);
      if (!fObj) continue;
      if (fObj.isApiFallback) apiFallbacks.push(fObj);
      else fontesDiretas.push(fObj);
    }
  }

  return {
    diretas: ordenarFontesDoItem(fontesDiretas, latenciasHost),
    apiFallbacks
  };
}

async function resolverFilmesExclusivosApi(filmesSemFonteDireta, latenciasHost) {
  if (!filmesSemFonteDireta.length) return [];
  console.log(`\n🔍 Resolvendo ${filmesSemFonteDireta.length} títulos exclusivos da API...`);
  const resolvidos = [];
  const LOTE = 20;

  for (let i = 0; i < Math.min(filmesSemFonteDireta.length, 400); i += LOTE) {
    const slice = filmesSemFonteDireta.slice(i, i + LOTE);
    await Promise.all(
      slice.map(async (filme) => {
        const novasFontes = [];
        for (const apiObj of (filme._apiFallbacks || [])) {
          try {
            const res = await axios.get(apiObj.url, {
              timeout: 8000,
              maxRedirects: 5,
              headers: {
                'User-Agent': SAIMO_APP_UA,
                'Accept': '*/*',
                'X-Saimo-Client': 'SaimoTV-cliente'
              },
              responseType: 'text',
              transformResponse: [(d) => d],
              validateStatus: (s) => s >= 200 && s < 400
            });
            const finalUrl = res.request?.res?.responseUrl || '';
            if (finalUrl && !isSaimoApiStreamUrl(finalUrl)) {
              const norm = normalizeMediaUrl(finalUrl);
              if (norm) novasFontes.push({ url: norm, idioma: apiObj.idioma });
            } else if (res.data) {
              const matches = String(res.data).match(/https?:\/\/[^"'\s\\]+(?:\.mp4|\.m3u8|master\.txt|\/api\/proxy\?url=)[^"'\s\\]*/gi) || [];
              for (const m of matches) {
                if (!isSaimoApiStreamUrl(m)) {
                  const norm = normalizeMediaUrl(m);
                  if (norm) novasFontes.push({ url: norm, idioma: apiObj.idioma });
                }
              }
            }
          } catch (_) {}
        }
        delete filme._apiFallbacks;
        if (novasFontes.length > 0) {
          filme.fontes = ordenarFontesDoItem(novasFontes, latenciasHost);
          resolvidos.push(filme);
        }
      })
    );
  }
  console.log(`  [+] ${resolvidos.length} títulos de API convertidos para link direto!`);
  return resolvidos;
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
    const genres = (d.genres || []).map((g) => g.name);
    return {
      logo: logo && logo.file_path ? `${TMDB_IMG_LOGO}${logo.file_path}` : '',
      backdrop: d.backdrop_path ? `${TMDB_IMG_BACKDROP}${d.backdrop_path}` : '',
      poster: d.poster_path ? `${TMDB_IMG_POSTER}${d.poster_path}` : '',
      desc: (d.overview || '').trim(),
      year: releaseYear,
      genre: genres[0] || ''
    };
  } catch (_) {
    return null;
  }
}

async function enrichItemsWithTmdbLogos(allItems, tmdbCache) {
  // Prioriza consultar no TMDB os títulos mais recentes (2026 -> 2025...) sem alterar a ordem original da lista!
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
      if ((!it.genre || it.genre === 'Filme' || it.genre === 'Série') && cached.genre) it.genre = cached.genre;
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

/**
 * 1. CANAIS: Mantém TODOS os canais na ordem original (sem unificar nomes parecidos)
 */
async function processarCanais() {
  console.log('\n📺 1. Baixando todos os canais de canais-saimo.pages.dev (sem unificar)...');
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
    const ord = ordenarFontesDoItem(conv, null);
    if (ord.length > 0) {
      id++;
      out.push({ id: String(id), nome: c.nome, categoria: c.categoria, logo: c.logo, urls: ord.map((x) => x.url) });
    }
  }
  saveJsonFile('canais_sm.json', out);
}

async function carregarMetadadosVOD() {
  console.log('\n🎬 2. Carregando índice, fichas, destaques, detalhes e marcas.txt...');
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
      if (c[0]) gavetas.push({ letra: c[0].trim(), filmes: parseInt(c[1] || '0', 10), series: parseInt(c[2] || '0', 10) });
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
    const k = normKey(tipo, tit, ano);
    if (!metaMap.has(k)) metaMap.set(k, { tmdbId: '', thumb: '', bannerThumb: '', genre: '', year: extrairAnoDoTitulo(tit) || ano, desc: '' });
    return metaMap.get(k);
  };

  for (let l of (fichasTxt || '').split(/\r?\n/)) {
    l = l.trim();
    if (!l || l.startsWith('#') || l.startsWith('capa:')) continue;
    const c = l.split('\t');
    if (c.length >= 4) {
      const m = getOrInit(c[0], c[1]);
      if (c[2] && /^\d+$/.test(c[2].trim())) {
        m.tmdbId = Number(c[2].trim());
        metaPorTmdbId.set(`${c[0].toLowerCase()}_${m.tmdbId}`, m);
      }
      if (c[3]) {
        const img = c[3].startsWith('http') ? c[3] : `${TMDB_IMG_POSTER}${c[3].startsWith('/') ? '' : '/'}${c[3]}`;
        m.thumb = img; m.bannerThumb = img;
      }
      if (c[4]) m.genre = c[4].split(',')[0].trim();
    }
  }

  for (let l of (destaquesTxt || '').split(/\r?\n/)) {
    l = l.trim();
    if (!l || l.startsWith('#') || l.startsWith('capa:') || l.startsWith('fila\t')) continue;
    const c = l.split('\t');
    if (c.length >= 5 && ['f', 's', 'a', 'd'].includes(c[0])) {
      const anoDest = (c[3] || '').trim();
      const m = getOrInit(c[0], c[1], anoDest);
      if (c[4] && !m.thumb) {
        const img = c[4].startsWith('http') ? c[4] : `${TMDB_IMG_POSTER}${c[4].startsWith('/') ? '' : '/'}${c[4]}`;
        m.thumb = img; m.bannerThumb = img;
      }
      if (anoDest && !m.year) m.year = anoDest;
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
      const anoDet = (c[2] || '').trim();
      const m = getOrInit(c[0], c[1]);
      if (anoDet) m.year = anoDet;
      if (anoDet) {
        const mComAno = getOrInit(c[0], c[1], anoDet);
        if (!mComAno.year) mComAno.year = anoDet;
        if (!mComAno.thumb && m.thumb) { mComAno.thumb = m.thumb; mComAno.bannerThumb = m.bannerThumb; }
        if (!mComAno.tmdbId && m.tmdbId) mComAno.tmdbId = m.tmdbId;
        if (!mComAno.genre && m.genre) mComAno.genre = m.genre;
      }
    }
  }

  const latenciasHost = await medirVelocidadeBases(bases);
  return { bases, gavetas, metaMap, metaPorTmdbId, normKey, marcasMap, latenciasHost, destaquesTxt };
}

/**
 * 3. COLETA TODOS OS ~31.500 FILMES E ~7.600 SÉRIES (SEM UNIFICAR TÍTULOS)
 */
async function coletarVOD(bases, gavetas, metaMap, metaPorTmdbId, normKey, marcasMap, latenciasHost) {
  const filmesCartoonzine = [];
  const filmesApenasApi = [];
  const seriesCartoonzine = [];

  console.log('\n🎥 3. Extraindo todos os Filmes (# e A-Z, sem unificar)...');
  const todasLetras = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];

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
      const anoExtraido = extrairAnoDoTitulo(tituloBruto);
      const tmdbIdNaLinha = extrairTmdbIdDaLinha(l);
      const { diretas, apiFallbacks } = extrairFontes(c, bases, marcasMap, latenciasHost);

      const meta =
        (tmdbIdNaLinha && metaPorTmdbId.get(`f_${tmdbIdNaLinha}`)) ||
        metaMap.get(normKey('f', tituloBruto, anoExtraido)) ||
        metaMap.get(normKey('f', tituloBruto)) ||
        {};

      const finalTmdbId = tmdbIdNaLinha || meta.tmdbId || null;

      const obj = {
        cat: 'Filmes',
        title: limparTituloExibicao(tituloBruto),
        desc: meta.desc || '',
        thumb: meta.thumb || '',
        bannerThumb: meta.bannerThumb || '',
        logo: '',
        bannerlogo: '',
        year: anoExtraido || meta.year || '',
        genre: meta.genre || 'Filme',
        fontes: diretas
      };
      if (finalTmdbId) {
        obj.tmdbId = finalTmdbId;
        obj.tmdbTipo = 'movie';
      }

      if (diretas.length > 0) {
        filmesCartoonzine.push(obj);
      } else if (apiFallbacks.length > 0) {
        obj._apiFallbacks = apiFallbacks;
        filmesApenasApi.push(obj);
      }
    }
  }

  if (filmesApenasApi.length > 0) {
    const recuperados = await resolverFilmesExclusivosApi(filmesApenasApi, latenciasHost);
    filmesCartoonzine.push(...recuperados);
  }

  console.log('\n📺 4. Extraindo todas as Séries (# e A-Z, sem unificar)...');
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
      const fechar = () => {
        if (!atual) return;
        atual.seasons = Object.keys(atual.seasonsMap).sort((a, b) => Number(a) - Number(b)).map((s) => ({
          season: parseInt(s, 10),
          episodes: atual.seasonsMap[s].map((ep) => ({ ...ep, fontes: ordenarFontesDoItem(ep.fontes, latenciasHost) })).filter((ep) => ep.fontes.length > 0).sort((a, b) => a.episode - b.episode)
        })).filter((s) => s.episodes.length > 0);
        delete atual.seasonsMap;
        if (atual.seasons.length > 0) seriesCartoonzine.push(atual);
      };

      for (let l of (txt || '').split(/\r?\n/)) {
        l = l.trim();
        if (!l || l.startsWith('#')) continue;
        if (l.startsWith('@')) {
          fechar();
          const c = l.slice(1).split('\t');
          const tit = limparTituloExibicao(c[0] || '');
          const anoS = (c[1] || '').trim();
          const meta = metaMap.get(normKey('s', tit, anoS)) || metaMap.get(normKey('s', tit)) || {};
          atual = {
            cat: 'Séries', title: tit, desc: meta.desc || '', thumb: meta.thumb || '', bannerThumb: meta.bannerThumb || '',
            logo: '', bannerlogo: '', year: anoS || meta.year || '', genre: meta.genre || 'Série', seasonsMap: {}
          };
          if (meta.tmdbId) { atual.tmdbId = meta.tmdbId; atual.tmdbTipo = 'tv'; }
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
              if (fObj && !fObj.isApiFallback) ep.fontes.push(fObj);
            }
          }
        }
      }
      fechar();
    }
  }

  return { filmesCartoonzine, seriesCartoonzine };
}

/**
 * 4. COLETA TODOS OS 1.322 ANIMES E 264 DORAMAS (SEM UNIFICAR TÍTULOS)
 */
async function coletarRedeFlix(caminho, catLabel, tipoMeta, bases, metaMap, normKey, marcasMap, latenciasHost) {
  console.log(`\n✨ Extraindo ${catLabel} (sem unificar)...`);
  const txt = await fetchText(`${FILMES_BASE_URL}/${caminho}`);
  if (!txt) return [];
  const listaFinal = [];
  let atual = null;

  const fechar = () => {
    if (!atual) return;
    atual.seasons = Object.keys(atual.seasonsMap).sort((a, b) => Number(a) - Number(b)).map((s) => ({
      season: parseInt(s, 10),
      episodes: atual.seasonsMap[s].map((ep) => ({ ...ep, fontes: ordenarFontesDoItem(ep.fontes, latenciasHost) })).filter((ep) => ep.fontes.length > 0).sort((a, b) => a.episode - b.episode)
    })).filter((s) => s.episodes.length > 0);
    delete atual.seasonsMap;
    if (atual.seasons.length > 0) listaFinal.push(atual);
  };

  for (let l of txt.split(/\r?\n/)) {
    l = l.trim();
    if (!l || l.startsWith('#')) continue;
    if (l.startsWith('@')) {
      fechar();
      const c = l.slice(1).split('\t');
      const tit = limparTituloExibicao(c[0] || '');
      const anoItem = (c[1] || '').trim();
      const meta = metaMap.get(normKey(tipoMeta, tit, anoItem)) || metaMap.get(normKey('s', tit, anoItem)) || metaMap.get(normKey(tipoMeta, tit)) || metaMap.get(normKey('s', tit)) || {};
      atual = {
        cat: catLabel, title: tit, desc: meta.desc || '', thumb: meta.thumb || '', bannerThumb: meta.bannerThumb || '',
        logo: '', bannerlogo: '', year: anoItem || meta.year || '', genre: meta.genre || catLabel, seasonsMap: {}
      };
      if (catLabel === 'Animes') atual.anime = true;
      const tid = (/^\d+$/.test((c[2] || '').trim()) ? Number(c[2].trim()) : null) || meta.tmdbId;
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
          if (fObj && !fObj.isApiFallback) ep.fontes.push(fObj);
        }
      }
    }
  }
  fechar();
  return listaFinal;
}

async function processarDestaques(destaquesTxt, metaMap, normKey, tmdbCache) {
  if (!destaquesTxt) return;
  let capaBase = 'https://image.tmdb.org/t/p/w342';
  const destaques = [];
  let fila = null;

  for (let l of destaquesTxt.split(/\r?\n/)) {
    l = l.trim();
    if (!l || l.startsWith('#')) continue;
    if (l.startsWith('capa:')) { capaBase = l.replace('capa:', '').trim(); continue; }
    const c = l.split('\t');
    if (c[0] === 'fila' && c.length >= 2) {
      fila = { titulo: c[1], itens: [] };
      destaques.push(fila);
    } else if (fila && ['f', 's', 'a', 'd'].includes(c[0]) && c.length >= 5) {
      const tit = limparTituloExibicao(c[1]);
      const anoD = (c[3] || '').trim();
      const meta = metaMap.get(normKey(c[0], c[1], anoD)) || metaMap.get(normKey(c[0], tit)) || metaMap.get(normKey('s', tit)) || {};
      const cached = meta.tmdbId ? tmdbCache[`${c[0] === 'f' ? 'movie' : 'tv'}_${meta.tmdbId}`] : null;
      const logoUrl = (cached && cached.logo) || '';
      fila.itens.push({
        tipo: c[0] === 'f' ? 'Filme' : c[0] === 's' ? 'Série' : c[0] === 'a' ? 'Anime' : 'Dorama',
        titulo: tit, ano: anoD,
        capa: c[4] ? (c[4].startsWith('http') ? c[4] : capaBase + c[4]) : '',
        bannerThumb: (cached && cached.backdrop) || '', logo: logoUrl, bannerlogo: logoUrl
      });
    }
  }
  if (destaques.length > 0) saveJsonFile('destaques_sm.json', destaques);
}

function saveJsonFile(filename, items) {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, filename), JSON.stringify(items, null, 2), 'utf-8');
  console.log(`  [✓] listas/${filename} salvo (${items.length.toLocaleString('pt-BR')} registros)`);
}

(async () => {
  try {
    await processarCanais();
    const { bases, gavetas, metaMap, metaPorTmdbId, normKey, marcasMap, latenciasHost, destaquesTxt } = await carregarMetadadosVOD();
    const { filmesCartoonzine, seriesCartoonzine } = await coletarVOD(bases, gavetas, metaMap, metaPorTmdbId, normKey, marcasMap, latenciasHost);
    const animes = await coletarRedeFlix('redeflix/links-animes.txt', 'Animes', 'a', bases, metaMap, normKey, marcasMap, latenciasHost);
    const doramas = await coletarRedeFlix('redeflix/links-doramas.txt', 'Doramas', 'd', bases, metaMap, normKey, marcasMap, latenciasHost);

    const tmdbCache = loadTmdbCache();
    await enrichItemsWithTmdbLogos([...doramas, ...animes, ...seriesCartoonzine, ...filmesCartoonzine], tmdbCache);

    saveJsonFile('filmes_sm.json', filmesCartoonzine);
    const tam = Math.ceil(seriesCartoonzine.length / 3) || 0;
    saveJsonFile('series_sm_pt1.json', seriesCartoonzine.slice(0, tam));
    saveJsonFile('series_sm_pt2.json', seriesCartoonzine.slice(tam, tam * 2));
    saveJsonFile('series_sm_pt3.json', seriesCartoonzine.slice(tam * 2));
    saveJsonFile('animes_sm.json', animes);
    saveJsonFile('doramas_sm.json', doramas);
    await processarDestaques(destaquesTxt, metaMap, normKey, tmdbCache);

    console.log('\n✅ TUDO CONCLUÍDO COM SUCESSO (100% DOS REGISTROS ORIGINAIS MANTIDOS)!');
  } catch (err) {
    console.error('❌ Erro fatal:', err);
    process.exit(1);
  }
})();
