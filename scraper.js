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
    .replace(/\s*\[(4k|uhd|fhd|1080p|720p|hd|sd|dub|leg)\]\s*/gi, ' ')
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
  } else if (/\.(mp4|mkv|m4v|webm)(\?|$)/i.test(url)) {
    score += 800;
  } else if (/\.m3u8(\?|$)/i.test(url)) {
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
    if (!valor) continue;

    if (chave === 'canal') {
      ultimaFonteObj = null;
      const normKey = chaveCanalUnico(valor);
      if (!canaisMap.has(normKey)) {
        canalAtual = {
          nome: valor.replace(/\s+(HD|FHD|4K)$/i, '').trim(),
          logo: '',
          categoria: classificarCanal(valor),
          fontesBrutas: []
        };
        canaisMap.set(normKey, canalAtual);
      } else {
        canalAtual = canaisMap.get(normKey);
      }
    } else if (canalAtual && chave === 'logo') {
      if (!canalAtual.logo) canalAtual.logo = valor;
    } else if (canalAtual && chave === 'categoria') {
      canalAtual.categoria = valor;
    } else if (canalAtual && chave === 'fonte') {
      if (isValidMediaUrl(valor)) {
        ultimaFonteObj = { rawUrl: valor, referer: '', ua: '', qualidade: '' };
        canalAtual.fontesBrutas.push(ultimaFonteObj);
      } else {
        ultimaFonteObj = null;
      }
    } else if (ultimaFonteObj && chave === 'qualidade') {
      ultimaFonteObj.qualidade = valor;
    } else if (ultimaFonteObj && chave === 'referer') {
      ultimaFonteObj.referer = valor;
    } else if (ultimaFonteObj && chave === 'agente') {
      ultimaFonteObj.ua = valor;
    }
  }

  if (canaisM3uTxt && canaisM3uTxt.includes('#EXTINF:')) {
    let pendente = null;
    for (let linha of canaisM3uTxt.split(/\r?\n/)) {
      linha = linha.trim();
      if (!linha) continue;
      if (linha.startsWith('#EXTINF:')) {
        const logo = (linha.match(/tvg-logo="([^"]*)"/i) || [])[1] || '';
        const group = (linha.match(/group-title="([^"]*)"/i) || [])[1] || '';
        const nome = linha.split(',').pop()?.trim() || '';
        pendente = { nome, logo, categoria: group || classificarCanal(nome) };
      } else if (!linha.startsWith('#') && pendente && isValidMediaUrl(linha)) {
        const normKey = chaveCanalUnico(pendente.nome);
        if (canaisMap.has(normKey)) {
          const c = canaisMap.get(normKey);
          c.fontesBrutas.push({ rawUrl: linha, referer: '', ua: '', qualidade: '' });
          if (!c.logo && pendente.logo) c.logo = pendente.logo;
        } else if (pendente.nome) {
          canaisMap.set(normKey, {
            nome: pendente.nome.replace(/\s+(HD|FHD|4K)$/i, '').trim(),
            logo: pendente.logo,
            categoria: pendente.categoria,
            fontesBrutas: [{ rawUrl: linha, referer: '', ua: '', qualidade: '' }]
          });
        }
        pendente = null;
      }
    }
  }

  const canaisJSON = [];
  let contador = 0;

  for (const canal of canaisMap.values()) {
    const fontesConvertidas = [];
    for (const f of canal.fontesBrutas) {
      const u = normalizeHlsUrl(f.rawUrl, f.referer, f.ua);
      if (u) {
        fontesConvertidas.push({ url: u, idioma: 'dublado', qualidade: f.qualidade });
      }
    }

    // Ordena as URLs do canal: melhor resolução (4K > FHD > HD) e link direto (.m3u8) na frente,
    // deixando fallback1.nexustvplay e proxies no final como reserva!
    const ordenadas = unificarEOrdenarFontes(fontesConvertidas, null).sort((a, b) => {
      const aFallback = a.url.includes('fallback') || a.url.includes('play.saimotv.com/api/proxy');
      const bFallback = b.url.includes('fallback') || b.url.includes('play.saimotv.com/api/proxy');
      if (aFallback !== bFallback) return aFallback ? 1 : -1;
      return 0;
    });

    if (ordenadas.length > 0) {
      contador++;
      canaisJSON.push({
        id: contador.toString(),
        nome: canal.nome,
        categoria: canal.categoria,
        logo: canal.logo,
        urls: ordenadas.map((x) => x.url)
      });
    }
  }

  saveJsonFile('canais_sm.json', canaisJSON);
}

/**
 * 2. CARREGA METADADOS DO ACERVO + marcas.txt (Resoluções 4K / FHD / HD / SD)
 */
async function carregarMetadadosVOD() {
  console.log('\n🎬 2. Carregando índice, fichas (TMDB ID), gêneros e marcas.txt (Resoluções)...');
  const [indiceTxt, fichasTxt, generosTxt, detalhesTxt, marcasTxt] = await Promise.all([
    fetchText(`${FILMES_BASE_URL}/indice.txt`),
    fetchText(`${FILMES_BASE_URL}/fichas.txt`),
    fetchText(`${FILMES_BASE_URL}/generos.txt`),
    fetchText(`${FILMES_BASE_URL}/detalhes.txt`),
    fetchText(`${FILMES_BASE_URL}/marcas.txt`)
  ]);

  const bases = {};
  const gavetas = [];

  for (let linha of indiceTxt.split(/\r?\n/)) {
    linha = linha.trim();
    if (!linha) continue;
    if (linha.startsWith('base:')) {
      const partes = linha.replace('base:', '').trim().split(/\s+/);
      if (partes.length >= 2) bases[partes[0]] = partes[1];
    } else if (linha.includes('\t')) {
      const campos = linha.split('\t');
      if (campos[0]) {
        gavetas.push({
          letra: campos[0].trim(),
          filmes: parseInt(campos[1] || '0', 10),
          series: parseInt(campos[2] || '0', 10),
          reservados: parseInt(campos[3] || '0', 10)
        });
      }
    }
  }

  // Lê marcas.txt: base:resto \t qualidade (4k, fhd, hd, sd)
  const marcasMap = new Map();
  if (marcasTxt) {
    for (let linha of marcasTxt.split(/\r?\n/)) {
      linha = linha.trim();
      if (!linha || linha.startsWith('#')) continue;
      const campos = linha.split('\t');
      if (campos.length >= 2) {
        marcasMap.set(campos[0].trim(), campos[1].trim().toLowerCase());
      }
    }
  }
  console.log(`  [+] Resoluções carregadas do marcas.txt: ${marcasMap.size.toLocaleString('pt-BR')} fontes medidas`);

  const metaMap = new Map();
  const normKey = (tipo, tit) => `${tipo.toLowerCase()}|${normalizarTituloChave(tit)}`;

  const getOrInit = (tipo, tit) => {
    const k = normKey(tipo, tit);
    if (!metaMap.has(k)) {
      metaMap.set(k, { tmdbId: '', thumb: '', bannerThumb: '', genre: '', year: '', desc: '' });
    }
    return metaMap.get(k);
  };

  if (fichasTxt) {
    for (let linha of fichasTxt.split(/\r?\n/)) {
      linha = linha.trim();
      if (!linha || linha.startsWith('#') || linha.startsWith('capa:')) continue;
      const campos = linha.split('\t');
      if (campos.length >= 4) {
        const [tipo, titulo, tmdbId, posterPath, generos] = campos;
        const m = getOrInit(tipo, titulo);
        if (tmdbId && /^\d+$/.test(tmdbId.trim())) {
          m.tmdbId = Number(tmdbId.trim());
        }
        if (posterPath) {
          const fullImg = posterPath.startsWith('http') ? posterPath : `${TMDB_IMG_POSTER}${posterPath.startsWith('/') ? '' : '/'}${posterPath}`;
          m.thumb = fullImg;
          m.bannerThumb = fullImg;
        }
        if (generos) m.genre = generos.split(',')[0].trim();
      }
    }
  }

  if (generosTxt) {
    for (let linha of generosTxt.split(/\r?\n/)) {
      linha = linha.trim();
      if (!linha || linha.startsWith('#')) continue;
      const campos = linha.split('\t');
      if (campos.length >= 3) {
        const m = getOrInit(campos[0], campos[1]);
        if (!m.genre && campos[2]) m.genre = campos[2].split(',')[0].trim();
      }
    }
  }

  if (detalhesTxt) {
    for (let linha of detalhesTxt.split(/\r?\n/)) {
      linha = linha.trim();
      if (!linha || linha.startsWith('#')) continue;
      const campos = linha.split('\t');
      if (campos.length >= 3) {
        const [tipo, titulo, ano] = campos;
        const m = getOrInit(tipo, titulo);
        if (ano) m.year = ano.trim();
      }
    }
  }

  const latenciasHost = await medirVelocidadeBases(bases);

  return { bases, gavetas, metaMap, normKey, marcasMap, latenciasHost };
}

/**
 * 3. COLETA E UNIFICA FILMES E SÉRIES
 */
async function coletarVOD(bases, gavetas, metaMap, normKey, marcasMap, latenciasHost) {
  let filmesBrutos = [];
  let seriesBrutas = [];

  console.log('\n🎥 3. Extraindo e unificando Filmes...');
  const respostasFilmes = await Promise.all(
    gavetas.filter((g) => g.filmes > 0).map(async (g) => {
      const nomeArquivo = g.letra === '#' ? '%23' : g.letra;
      let txt = await fetchText(`${FILMES_BASE_URL}/filmes-${nomeArquivo}.txt`);
      if (!txt && g.letra === '#') txt = await fetchText(`${FILMES_BASE_URL}/filmes-#.txt`);
      return txt;
    })
  );

  for (const textoFilmes of respostasFilmes) {
    if (!textoFilmes) continue;
    for (let linha of textoFilmes.split(/\r?\n/)) {
      linha = linha.trim();
      if (!linha || linha.startsWith('#')) continue;
      const campos = linha.split('\t');
      if (campos.length < 2 || !campos[0]) continue;

      const tituloCompleto = campos[0].trim();
      const matchAno = tituloCompleto.match(/\((\d{4})\)\s*$/);
      const anoExtraido = matchAno ? matchAno[1] : '';
      const tituloLimpo = limparTituloExibicao(tituloCompleto);

      const fontesFilme = extrairFontes(campos, bases, marcasMap, latenciasHost);
      if (fontesFilme.length === 0) continue;

      const meta = metaMap.get(normKey('f', tituloCompleto)) || {};

      const movieObj = {
        cat: 'Filmes',
        title: tituloLimpo,
        desc: meta.desc || '',
        thumb: meta.thumb || '',
        bannerThumb: meta.bannerThumb || '',
        logo: '',
        bannerlogo: '',
        year: meta.year || anoExtraido,
        genre: meta.genre || 'Filme',
        fontes: fontesFilme
      };
      if (meta.tmdbId) {
        movieObj.tmdbId = meta.tmdbId;
        movieObj.tmdbTipo = 'movie';
      }

      filmesBrutos.push(movieObj);
    }
  }

  const filmesCartoonzine = unificarTitulosRepetidos(filmesBrutos, latenciasHost, false);

  console.log('\n📺 4. Extraindo e unificando Séries com Temporadas e Episódios...');
  for (const g of gavetas) {
    if (g.series <= 0) continue;
    const letra = g.letra;
    const nomeArquivo = letra === '#' ? '%23' : letra;

    let textoSeriesIdx = await fetchText(`${FILMES_BASE_URL}/series-${nomeArquivo}.txt`);
    if (!textoSeriesIdx && letra === '#') {
      textoSeriesIdx = await fetchText(`${FILMES_BASE_URL}/series-#.txt`);
    }
    if (!textoSeriesIdx) continue;

    const pedacosSet = new Set();
    for (const linha of textoSeriesIdx.split(/\r?\n/)) {
      const campos = linha.split('\t');
      if (campos.length >= 3 && campos[2]) pedacosSet.add(campos[2].trim());
    }

    const pedacosArray = Array.from(pedacosSet);
    const textosPedacos = await Promise.all(
      pedacosArray.map(async (pedaco) => {
        let t = await fetchText(`${FILMES_BASE_URL}/series-${nomeArquivo}-${pedaco}.txt`);
        if (!t && letra === '#') t = await fetchText(`${FILMES_BASE_URL}/series-#-${pedaco}.txt`);
        return t;
      })
    );

    for (const textoPedaco of textosPedacos) {
      if (!textoPedaco) continue;
      let serieAtual = null;

      const salvarSerieAtual = () => {
        if (serieAtual) {
          serieAtual.seasons = Object.keys(serieAtual.seasonsMap)
            .sort((a, b) => Number(a) - Number(b))
            .map((sNum) => ({
              season: parseInt(sNum, 10),
              episodes: serieAtual.seasonsMap[sNum]
                .map((ep) => {
                  ep.fontes = unificarEOrdenarFontes(ep.fontes, latenciasHost);
                  return ep;
                })
                .filter((ep) => ep.fontes.length > 0)
                .sort((a, b) => a.episode - b.episode)
            }))
            .filter((s) => s.episodes.length > 0);

          delete serieAtual.seasonsMap;
          if (serieAtual.seasons.length > 0) {
            seriesBrutas.push(serieAtual);
          }
        }
      };

      for (let linha of textoPedaco.split(/\r?\n/)) {
        linha = linha.trim();
        if (!linha || linha.startsWith('#')) continue;

        if (linha.startsWith('@')) {
          salvarSerieAtual();
          const camposCabecalho = linha.substring(1).split('\t');
          const tituloSerie = limparTituloExibicao(camposCabecalho[0] || '');
          const anoSerie = (camposCabecalho[1] || '').trim();
          const meta = metaMap.get(normKey('s', tituloSerie)) || {};

          serieAtual = {
            cat: 'Séries',
            title: tituloSerie,
            desc: meta.desc || '',
            thumb: meta.thumb || '',
            bannerThumb: meta.bannerThumb || '',
            logo: '',
            bannerlogo: '',
            year: anoSerie || meta.year || '',
            genre: meta.genre || 'Série',
            seasonsMap: {}
          };
          if (meta.tmdbId) {
            serieAtual.tmdbId = meta.tmdbId;
            serieAtual.tmdbTipo = 'tv';
          }
        } else if (serieAtual) {
          const camposEp = linha.split('\t');
          if (camposEp.length >= 4) {
            const tempNum = parseInt(camposEp[0], 10) || 1;
            const epNum = parseInt(camposEp[1], 10) || 1;
            const idioma = camposEp[2].trim().toLowerCase() === 'leg' ? 'legendado' : 'dublado';
            const urlsBrutas = camposEp[3].split(',');

            if (!serieAtual.seasonsMap[tempNum]) {
              serieAtual.seasonsMap[tempNum] = [];
            }

            let episodioExistente = serieAtual.seasonsMap[tempNum].find((e) => e.episode === epNum);
            if (!episodioExistente) {
              episodioExistente = { season: tempNum, episode: epNum, fontes: [] };
              serieAtual.seasonsMap[tempNum].push(episodioExistente);
            }

            for (const urlBruta of urlsBrutas) {
              const fObj = montarFonteComQualidade(urlBruta, idioma, bases, marcasMap);
              if (fObj) episodioExistente.fontes.push(fObj);
            }
          }
        }
      }
      salvarSerieAtual();
    }
  }

  const seriesCartoonzine = unificarTitulosRepetidos(seriesBrutas, latenciasHost, true);

  return { filmesCartoonzine, seriesCartoonzine };
}

/**
 * 4. COLETA E UNIFICA ANIMES E DORAMAS
 */
async function coletarRedeFlix(caminhoRelativo, catLabel, tipoMeta, bases, metaMap, normKey, marcasMap, latenciasHost) {
  console.log(`\n✨ Extraindo e unificando ${catLabel} (${caminhoRelativo})...`);
  const texto = await fetchText(`${FILMES_BASE_URL}/${caminhoRelativo}`);
  if (!texto) return [];

  const listaBruta = [];
  let itemAtual = null;

  const salvarItemAtual = () => {
    if (itemAtual) {
      itemAtual.seasons = Object.keys(itemAtual.seasonsMap)
        .sort((a, b) => Number(a) - Number(b))
        .map((sNum) => ({
          season: parseInt(sNum, 10),
          episodes: itemAtual.seasonsMap[sNum]
            .map((ep) => {
              ep.fontes = unificarEOrdenarFontes(ep.fontes, latenciasHost);
              return ep;
            })
            .filter((ep) => ep.fontes.length > 0)
            .sort((a, b) => a.episode - b.episode)
        }))
        .filter((s) => s.episodes.length > 0);

      delete itemAtual.seasonsMap;
      if (itemAtual.seasons.length > 0) {
        listaBruta.push(itemAtual);
      }
    }
  };

  for (let linha of texto.split(/\r?\n/)) {
    linha = linha.trim();
    if (!linha || linha.startsWith('#')) continue;

    if (linha.startsWith('@')) {
      salvarItemAtual();
      const camposCabecalho = linha.substring(1).split('\t');
      const titulo = limparTituloExibicao(camposCabecalho[0] || '');
      const ano = (camposCabecalho[1] || '').trim();
      const idTmdbCabecalho = (camposCabecalho[2] || '').trim();

      const meta =
        metaMap.get(normKey(tipoMeta, titulo)) ||
        metaMap.get(normKey('s', titulo)) ||
        {};

      itemAtual = {
        cat: catLabel,
        title: titulo,
        desc: meta.desc || '',
        thumb: meta.thumb || '',
        bannerThumb: meta.bannerThumb || '',
        logo: '',
        bannerlogo: '',
        year: ano || meta.year || '',
        genre: meta.genre || catLabel,
        seasonsMap: {}
      };

      if (catLabel === 'Animes') {
        itemAtual.anime = true;
      }

      const finalTmdbId = (/^\d+$/.test(idTmdbCabecalho) ? Number(idTmdbCabecalho) : null) || meta.tmdbId;
      if (finalTmdbId) {
        itemAtual.tmdbId = finalTmdbId;
        itemAtual.tmdbTipo = 'tv';
      }
    } else if (itemAtual) {
      const camposEp = linha.split('\t');
      if (camposEp.length >= 4) {
        const tempNum = parseInt(camposEp[0], 10) || 1;
        const epNum = parseInt(camposEp[1], 10) || 1;
        const idioma = camposEp[2].trim().toLowerCase() === 'leg' ? 'legendado' : 'dublado';
        const urlsBrutas = camposEp[3].split(',');

        if (!itemAtual.seasonsMap[tempNum]) {
          itemAtual.seasonsMap[tempNum] = [];
        }

        let episodioExistente = itemAtual.seasonsMap[tempNum].find((e) => e.episode === epNum);
        if (!episodioExistente) {
          episodioExistente = { season: tempNum, episode: epNum, fontes: [] };
          itemAtual.seasonsMap[tempNum].push(episodioExistente);
        }

        for (const urlBruta of urlsBrutas) {
          const fObj = montarFonteComQualidade(urlBruta, idioma, bases, marcasMap);
          if (fObj) episodioExistente.fontes.push(fObj);
        }
      }
    }
  }
  salvarItemAtual();

  return unificarTitulosRepetidos(listaBruta, latenciasHost, true);
}

/**
 * 5. DESTAQUES
 */
async function processarDestaques(metaMap, normKey, tmdbCache) {
  console.log('\n🌟 Processando Destaques da Tela Inicial...');
  const texto = await fetchText(`${FILMES_BASE_URL}/destaques.txt`);
  if (!texto) return;

  let capaBase = 'https://image.tmdb.org/t/p/w342';
  const destaques = [];
  let filaAtual = null;

  for (let linha of texto.split(/\r?\n/)) {
    linha = linha.trim();
    if (!linha || linha.startsWith('#')) continue;

    if (linha.startsWith('capa:')) {
      capaBase = linha.replace('capa:', '').trim();
      continue;
    }

    const campos = linha.split('\t');
    if (campos[0] === 'fila' && campos.length >= 2) {
      filaAtual = { titulo: campos[1], itens: [] };
      destaques.push(filaAtual);
      continue;
    }

    if (filaAtual && ['f', 's', 'a', 'd'].includes(campos[0]) && campos.length >= 5) {
      const codTipo = campos[0];
      const tipo = codTipo === 'f' ? 'Filme' : codTipo === 's' ? 'Série' : codTipo === 'a' ? 'Anime' : 'Dorama';
      const titulo = limparTituloExibicao(campos[1]);
      const ano = campos[3];
      const posterPath = campos[4];

      const meta = metaMap.get(normKey(codTipo, titulo)) || metaMap.get(normKey('s', titulo)) || {};
      const tmdbTipo = codTipo === 'f' ? 'movie' : 'tv';
      const cached = meta.tmdbId ? tmdbCache[`${tmdbTipo}_${meta.tmdbId}`] : null;
      const logoUrl = (cached && cached.logo) || '';

      filaAtual.itens.push({
        tipo,
        titulo,
        ano,
        capa: posterPath ? (posterPath.startsWith('http') ? posterPath : capaBase + posterPath) : '',
        bannerThumb: (cached && cached.backdrop) || '',
        logo: logoUrl,
        bannerlogo: logoUrl
      });
    }
  }

  if (destaques.length > 0) {
    saveJsonFile('destaques_sm.json', destaques);
  }
}

function saveJsonFile(filename, items) {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  const fullPath = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(fullPath, JSON.stringify(items, null, 2), 'utf-8');
  console.log(`  [✓] listas/${filename} salvo (${items.length.toLocaleString('pt-BR')} registros únicos)`);
}

(async () => {
  try {
    console.log('======================================================');
    console.log('🚀 CARTOONZINE SM SCRAPER — UNIFICADOR + RANKING 4K/MS');
    console.log('======================================================');

    await processarCanais();
    const { bases, gavetas, metaMap, normKey, marcasMap, latenciasHost } = await carregarMetadadosVOD();

    const { filmesCartoonzine, seriesCartoonzine } = await coletarVOD(bases, gavetas, metaMap, normKey, marcasMap, latenciasHost);
    const animes = await coletarRedeFlix('redeflix/links-animes.txt', 'Animes', 'a', bases, metaMap, normKey, marcasMap, latenciasHost);
    const doramas = await coletarRedeFlix('redeflix/links-doramas.txt', 'Doramas', 'd', bases, metaMap, normKey, marcasMap, latenciasHost);

    const tmdbCache = loadTmdbCache();
    await enrichItemsWithTmdbLogos(
      [...doramas, ...animes, ...seriesCartoonzine, ...filmesCartoonzine],
      tmdbCache
    );

    saveJsonFile('filmes_sm.json', filmesCartoonzine);

    const tamanho = Math.ceil(seriesCartoonzine.length / 3) || 0;
    saveJsonFile('series_sm_pt1.json', seriesCartoonzine.slice(0, tamanho));
    saveJsonFile('series_sm_pt2.json', seriesCartoonzine.slice(tamanho, tamanho * 2));
    saveJsonFile('series_sm_pt3.json', seriesCartoonzine.slice(tamanho * 2));

    saveJsonFile('animes_sm.json', animes);
    saveJsonFile('doramas_sm.json', doramas);

    await processarDestaques(metaMap, normKey, tmdbCache);

    console.log('\n======================================================');
    console.log('✅ TUDO CONCLUÍDO E UNIFICADO COM SUCESSO!');
    console.log('======================================================');
  } catch (err) {
    console.error('❌ Erro fatal:', err);
    process.exit(1);
  }
})();
