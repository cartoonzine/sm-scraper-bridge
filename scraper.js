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
const MAX_TMDB_FETCH_PER_RUN = 6000;
const TMDB_CONCURRENCY = 30;

const http = axios.create({
  timeout: 25000,
  headers: {
    'User-Agent': DEFAULT_UA,
    'Accept': 'text/plain, application/json, */*'
  },
  responseType: 'text',
  transformResponse: [(data) => data]
});

async function fetchText(url) {
  try {
    const res = await http.get(url);
    if (res.status >= 200 && res.status < 300 && typeof res.data === 'string') {
      return res.data;
    }
  } catch (_) {}
  return '';
}

/**
 * Normaliza títulos para encontrar duplicados mesmo com acentos, maiúsculas ou tags [4K]/[HD] diferentes
 */
function normalizarTituloChave(titulo) {
  return String(titulo || '')
    .replace(/\s*\(\d{4}\)\s*$/g, '')
    .replace(/\[.*?\]/g, '')
    .replace(/\b(4k|uhd|fhd|1080p|720p|hd|sd|dublado|legendado|dub|leg|dual)\b/gi, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/**
 * Limpa sufixos de qualidade do título exibido para unificar visualmente o card
 */
function limparTituloExibicao(titulo) {
  return String(titulo || '')
    .replace(/\s*\(\d{4}\)\s*$/g, '')
    .replace(/\s*\[(4k\vert{}uhd\vert{}fhd\vert{}1080p\vert{}720p\vert{}hd\vert{}sd\vert{}dub\vert{}leg)\]\s*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isValidMediaUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.trim();
  if (!u.startsWith('http://') && !u.startsWith('https://')) return false;

  const low = u.toLowerCase();
  if (low.includes('saimo-tv.pages.dev/api/') || low.includes('/api/stream')) {
    return false;
  }
  return true;
}

function normalizeHlsUrl(rawUrl, referer = '', userAgent = '') {
  if (!rawUrl || !isValidMediaUrl(rawUrl)) return null;
  let u = rawUrl.trim();
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
 * Mede a velocidade real (latência HTTP em ms) de cada servidor base do indice.txt
 */
async function medirVelocidadeBases(bases) {
  console.log('\n⚡ Medindo velocidade/latência dos servidores de mídia...');
  const latenciasHost = new Map();
  const entries = Object.entries(bases);

  await Promise.all(
    entries.map(async ([num, baseUrl]) => {
      let host = '';
      try {
        host = new URL(baseUrl).host;
      } catch (_) {
        return;
      }
      if (latenciasHost.has(host)) return;

      const t0 = Date.now();
      try {
        await axios.head(baseUrl, {
          timeout: 4500,
          headers: { 'User-Agent': DEFAULT_UA },
          validateStatus: () => true // Qualquer resposta HTTP (mesmo 403/404 na raiz) confirma que o servidor está vivo e rápido
        });
        const ms = Date.now() - t0;
        latenciasHost.set(host, ms);
        console.log(`  [Servidor Base ${num}] ${host} -> ${ms}ms`);
      } catch (_) {
        // Servidor lento ou sem resposta no HEAD
        latenciasHost.set(host, 9999);
        console.log(`  [Servidor Base ${num}] ${host} -> Lento/Timeout (vai para o fim da fila)`);
      }
    })
  );

  return latenciasHost;
}

/**
 * Pontua a qualidade da resolução (4K > FHD > HD > SD)
 */
function pontosQualidade(qStr, url = '') {
  const q = String(qStr || '').toLowerCase();
  const u = String(url || '').toLowerCase();
  if (q === '4k' || q === 'uhd' || q === '2160p' || /\b(4k|2160p|uhd)\b/.test(u)) return 400;
  if (q === 'fhd' || q === '1080p' || /\b(fhd|1080p)\b/.test(u)) return 300;
  if (q === 'hd' || q === '720p' || /\b(720p|hd)\b/.test(u)) return 200;
  if (q === 'sd' || q === '480p') return 100;
  return 250; // Padrão quando não especificado em marcas.txt (geralmente MP4 FHD/HD de base principal)
}

/**
 * Calcula o Score Total de uma fonte para colocar SEMPRE:
 * 1º Maior Resolução (4K > FHD > HD > SD)
 * 2º Link Direto (.mp4/.mkv/.m3u8 puro) acima de links .txt/proxy
 * 3º Servidor mais rápido (menor latência em ms)
 * 4º Dublado antes de Legendado como padrão
 */
function calcularScoreFonte(fonteObj, latenciasHost) {
  const url = fonteObj.url || '';
  let score = 0;

  // 1. Qualidade de Resolução (peso principal: +1000 a +4000)
  score += pontosQualidade(fonteObj.qualidade, url) * 10;

  // 2. Tipo de Link / Estabilidade (+800 para MP4/MKV direto, +600 para M3U8 direto, +200 para TXT/Proxy)
  if (url.includes('play.saimotv.com/api/proxy')) {
    score += 150;
  } else if (url.includes('master.txt') || url.includes('format=m3u8')) {
    score += 300;
  } else if (/\.(mp4|mkv|m4v|webm)(\?|$)/i.test(url)) { score += 800; } else if (/\.m3u8(\?\vert{}$)/i.test(url)) {
    score += 700;
  } else {
    score += 500;
  }

  // 3. Velocidade do Servidor (bônus de até +400 para servidores com ping baixo, penalidade para timeout)
  try {
    const host = new URL(url).host;
    const ms = latenciasHost ? (latenciasHost.get(host) ?? 500) : 500;
    if (ms >= 9000) {
      score -= 1500; // Servidor que deu timeout no teste cai para a última reserva
    } else {
      score += Math.max(0, 400 - Math.round(ms / 10));
    }
  } catch (_) {}

  // 4. Preferência por Dublado na primeira posição
  if (fonteObj.idioma === 'dublado') {
    score += 50;
  }

  return score;
}

/**
 * Remove fontes com URLs repetidas e ordena da melhor resolução + mais rápida para a última reserva
 */
function unificarEOrdenarFontes(listaFontes, latenciasHost) {
  const mapaPorUrl = new Map();

  for (const f of listaFontes) {
    if (!f || !f.url) continue;
    const existente = mapaPorUrl.get(f.url);
    if (!existente) {
      mapaPorUrl.set(f.url, { ...f });
    } else if (!existente.qualidade && f.qualidade) {
      existente.qualidade = f.qualidade;
    }
  }

  const unicas = Array.from(mapaPorUrl.values());
  unicas.sort((a, b) => calcularScoreFonte(b, latenciasHost) - calcularScoreFonte(a, latenciasHost));

  // Retorna mantendo o formato limpo { url, idioma, qualidade? }
  return unicas.map((f) => {
    const itemFonte = { url: f.url, idioma: f.idioma || 'dublado' };
    if (f.qualidade) itemFonte.qualidade = f.qualidade.toUpperCase();
    return itemFonte;
  });
}

function montarFonteComQualidade(valorBruto, idioma, bases, marcasMap) {
  if (!valorBruto) return null;
  const limpo = valorBruto.trim();
  if (!limpo) return null;

  // Verifica se existe qualidade registrada no marcas.txt para "0:1001"
  const qualidadeMarca = marcasMap ? (marcasMap.get(limpo) || '') : '';

  if (limpo.startsWith('http://') || limpo.startsWith('https://')) {
    const urlFinal = normalizeHlsUrl(limpo);
    return urlFinal ? { url: urlFinal, idioma, qualidade: qualidadeMarca } : null;
  }

  const partesUrl = limpo.split(':');
  if (partesUrl.length < 2) return null;

  const numero = partesUrl[0].trim();
  const resto = partesUrl.slice(1).join(':').trim();
  const base = bases[numero];
  if (!base || !resto) return null;

  const baseFormatada = base.endsWith('/') ? base : `${base}/`;
  const urlCrua = resto.includes('.') ? `${baseFormatada}${resto}` : `${baseFormatada}${resto}.mp4`;
  const urlFinal = normalizeHlsUrl(urlCrua);

  return urlFinal ? { url: urlFinal, idioma, qualidade: qualidadeMarca } : null;
}

function extrairFontes(campos, bases, marcasMap, latenciasHost) {
  const fontes = [];

  for (let i = 1; i < campos.length; i++) {
    const campo = (campos[i] || '').trim();
    if (!campo || !campo.includes('=')) continue;

    const idxEq = campo.indexOf('=');
    const prefixo = campo.slice(0, idxEq).toLowerCase().trim();
    const resto = campo.slice(idxEq + 1).trim();
    const idioma = (prefixo === 'leg' || prefixo.includes('leg')) ? 'legendado' : 'dublado';

    for (const urlBruta of resto.split(',')) {
      const fObj = montarFonteComQualidade(urlBruta, idioma, bases, marcasMap);
      if (fObj) fontes.push(fObj);
    }
  }

  return unificarEOrdenarFontes(fontes, latenciasHost);
}

/**
 * Faz o Deep Merge de duas listas de temporadas (seasons), unificando episódios iguais
 * e ordenando as fontes de cada episódio pela melhor resolução e velocidade!
 */
function mesclarTemporadas(seasonsA = [], seasonsB = [], latenciasHost) {
  const mapaTemp = new Map();

  const adicionarLista = (listaSeasons) => {
    for (const s of listaSeasons) {
      const sNum = parseInt(s.season, 10) || 1;
      if (!mapaTemp.has(sNum)) {
        mapaTemp.set(sNum, new Map());
      }
      const mapaEp = mapaTemp.get(sNum);

      for (const ep of (s.episodes || [])) {
        const epNum = parseInt(ep.episode, 10) || 1;
        if (!mapaEp.has(epNum)) {
          mapaEp.set(epNum, []);
        }
        mapaEp.get(epNum).push(...(ep.fontes || []));
      }
    }
  };

  adicionarLista(seasonsA);
  adicionarLista(seasonsB);

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
 * Unifica títulos repetidos numa categoria (Filmes, Séries, Animes ou Doramas)
 * juntando todas as fontes/episódios como reserva e mantendo a melhor em 1º lugar
 */
function unificarTitulosRepetidos(itens, latenciasHost, isSerie = false) {
  const mapaUnico = new Map();
  let duplicadosUnificados = 0;

  for (const item of itens) {
    const tituloBase = normalizarTituloChave(item.title);
    if (!tituloBase) continue;

    // Se tem tmdbId, usa o tmdbId como chave mestre (une até títulos com grafias diferentes do mesmo filme/série!).
    // Caso contrário, usa o título normalizado + ano.
    const chave = item.tmdbId
      ? `tmdb_${item.tmdbId}`
      : `norm_${tituloBase}_${item.year || ''}`;

    if (!mapaUnico.has(chave)) {
      const copia = {
        ...item,
        title: limparTituloExibicao(item.title)
      };
      if (isSerie) {
        copia.seasons = mesclarTemporadas(item.seasons || [], [], latenciasHost);
      } else {
        copia.fontes = unificarEOrdenarFontes(item.fontes || [], latenciasHost);
      }
      mapaUnico.set(chave, copia);
    } else {
      duplicadosUnificados++;
      const existente = mapaUnico.get(chave);

      // Mantém os melhores metadados disponíveis
      if (!existente.thumb && item.thumb) existente.thumb = item.thumb;
      if (!existente.bannerThumb && item.bannerThumb) existente.bannerThumb = item.bannerThumb;
      if (!existente.desc && item.desc) existente.desc = item.desc;
      if (!existente.year && item.year) existente.year = item.year;
      if (!existente.tmdbId && item.tmdbId) {
        existente.tmdbId = item.tmdbId;
        existente.tmdbTipo = item.tmdbTipo;
      }

      // Mescla as fontes ou temporadas/episódios como reserva ordenada por qualidade/velocidade
      if (isSerie) {
        existente.seasons = mesclarTemporadas(existente.seasons, item.seasons, latenciasHost);
      } else {
        existente.fontes = unificarEOrdenarFontes([...(existente.fontes || []), ...(item.fontes || [])], latenciasHost);
      }
    }
  }

  if (duplicadosUnificados > 0) {
    console.log(`  [♻️ Unificação] ${duplicadosUnificados} títulos repetidos foram fundidos como fontes reserva!`);
  }

  return Array.from(mapaUnico.values());
}

/**
 * CACHE TMDB (Logo PNG Transparente, Backdrop w1280 e Sinopse PT-BR)
 */
function loadTmdbCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
    }
  } catch (_) {}
  return {};
}

function saveTmdbCache(cacheObj) {
  try {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cacheObj), 'utf-8');
  } catch (_) {}
}

async function fetchTmdbDetails(tmdbId, tipo) {
  const endpoint = `${TMDB_API}/${tipo}/${tmdbId}?api_key=${TMDB_KEY}&language=pt-BR&append_to_response=images&include_image_language=pt,en,null`;
  try {
    const res = await http.get(endpoint, { timeout: 10000 });
    if (res.status !== 200 || !res.data) return null;
    const d = JSON.parse(res.data);

    const logos = (d.images && d.images.logos) || [];
    const chosenLogo =
      logos.find((l) => l.iso_639_1 === 'pt') ||
      logos.find((l) => l.iso_639_1 === 'en') ||
      logos[0];

    return {
      logo: chosenLogo && chosenLogo.file_path ? `${TMDB_IMG_LOGO}${chosenLogo.file_path}` : '',
      backdrop: d.backdrop_path ? `${TMDB_IMG_BACKDROP}${d.backdrop_path}` : '',
      poster: d.poster_path ? `${TMDB_IMG_POSTER}${d.poster_path}` : '',
      desc: (d.overview || '').trim()
    };
  } catch (_) {
    return null;
  }
}

async function enrichItemsWithTmdbLogos(allItems, tmdbCache) {
  const toFetch = [];
  for (const item of allItems) {
    if (!item.tmdbId || !item.tmdbTipo) continue;
    const key = `${item.tmdbTipo}_${item.tmdbId}`;
    if (!tmdbCache[key]) {
      toFetch.push({ key, tmdbId: item.tmdbId, tmdbTipo: item.tmdbTipo });
    }
  }

  const uniqueQueue = Array.from(new Map(toFetch.map((x) => [x.key, x])).values()).slice(0, MAX_TMDB_FETCH_PER_RUN);

  if (uniqueQueue.length > 0) {
    console.log(`\n🎨 Buscando Logos PNG e Backdrops no TMDB para ${uniqueQueue.length} títulos...`);
    for (let i = 0; i < uniqueQueue.length; i += TMDB_CONCURRENCY) {
      const batch = uniqueQueue.slice(i, i + TMDB_CONCURRENCY);
      await Promise.all(
        batch.map(async (q) => {
          const info = await fetchTmdbDetails(q.tmdbId, q.tmdbTipo);
          if (info) tmdbCache[q.key] = info;
        })
      );
      if ((i + TMDB_CONCURRENCY) % 600 === 0 || i + TMDB_CONCURRENCY >= uniqueQueue.length) {
        console.log(`  [TMDB Progresso]: ${Math.min(i + TMDB_CONCURRENCY, uniqueQueue.length)} / ${uniqueQueue.length}`);
      }
    }
    saveTmdbCache(tmdbCache);
  }

  for (const item of allItems) {
    const key = item.tmdbId ? `${item.tmdbTipo}_${item.tmdbId}` : null;
    const cached = key ? tmdbCache[key] : null;

    const logoUrl = (cached && cached.logo) || '';
    item.logo = logoUrl;
    item.bannerlogo = logoUrl;

    if (cached) {
      if (cached.backdrop) item.bannerThumb = cached.backdrop;
      if (!item.thumb && cached.poster) item.thumb = cached.poster;
      if (cached.desc) item.desc = cached.desc;
    }
  }
}

function classificarCanal(nome) {
  if (!nome) return 'Variedades';
  const n = nome.toLowerCase();
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
 * 1. CANAIS: Unifica canais com mesmo nome (mesmo com HD/FHD/4K no nome) e ordena fontes por resolução e velocidade
 */
async function processarCanais() {
  console.log('\n📺 1. Baixando e unificando canais de canais-saimo.pages.dev...');
  const [catalogoTxt, canaisM3uTxt] = await Promise.all([
    fetchText(`${CANAIS_BASE_URL}/catalogo.txt`),
    fetchText(`${CANAIS_BASE_URL}/canais.txt`)
  ]);

  const canaisMap = new Map();
  let canalAtual = null;
  let ultimaFonteObj = null;

  const chaveCanalUnico = (nome) =>
    String(nome || '')
      .toLowerCase()
      .replace(/\b(4k|uhd|fhd|1080p|hd|sd|h265|hevc)\b/gi, '')
      .replace(/[^a-z0-9]+/g, '')
      .trim();

  for (let linha of catalogoTxt.split(/\r?\n/)) {
    linha = linha.trim();
    if (!linha || linha.startsWith('#')) continue;

    const partes = linha.split(':');
    if (partes.length < 2) continue;

    const chave = partes.shift().trim().toLowerCase();
    const valor = partes.join(':').trim();
