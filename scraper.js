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
 * Remove apenas a API interna inútil (saimo-tv.pages.dev/api/stream).
 * Permite links .mp4, .m3u8 e também os HLS disfarçados (.txt).
 */
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

/**
 * Converte links HLS disfarçados (.txt como error.txt e master.txt) em links
 * reconhecidos como HLS (.m3u8) pelo format-detector.js e compatíveis com todas as plataformas.
 */
function normalizeHlsUrl(rawUrl, referer = '', userAgent = '') {
  if (!rawUrl || !isValidMediaUrl(rawUrl)) return null;
  let u = rawUrl.trim();
  const low = u.toLowerCase().split('?')[0];

  // Se o canal exige Referer (ou é do servidor s25-cloudfront-net.lat que exige referer do embedtv),
  // encapsula no proxy de streaming com &format=m3u8 no final para tocar em qualquer plataforma
  if (referer || low.includes('s25-cloudfront-net.lat/')) {
    const refFinal = referer || 'https://ww0.embedtv.cc/';
    const uaFinal = userAgent || DEFAULT_UA;
    return `${SAIMO_PROXY_URL}?url=${encodeURIComponent(u)}&referer=${encodeURIComponent(refFinal)}&ua=${encodeURIComponent(uaFinal)}&format=m3u8`;
  }

  // Se for um HLS disfarçado com extensão .txt (ex: embedplayer2.xyz/cdn/hls/.../master.txt),
  // acrescenta ?format=m3u8 para que qualquer player e o format-detector.js reconheçam como HLS
  if (low.endsWith('.txt') && !u.includes('format=m3u8')) {
    u += (u.includes('?') ? '&' : '?') + 'format=m3u8';
  }

  return u;
}

function montarUrl(valor, bases) {
  if (!valor) return null;
  const limpo = valor.trim();
  if (!limpo) return null;

  if (limpo.startsWith('http://') || limpo.startsWith('https://')) {
    return normalizeHlsUrl(limpo);
  }

  const partesUrl = limpo.split(':');
  if (partesUrl.length < 2) return null;

  const numero = partesUrl[0].trim();
  const resto = partesUrl.slice(1).join(':').trim();
  const base = bases[numero];
  if (!base || !resto) return null;

  const baseFormatada = base.endsWith('/') ? base : `${base}/`;
  const urlFinal = resto.includes('.') ? `${baseFormatada}${resto}` : `${baseFormatada}${resto}.mp4`;

  return normalizeHlsUrl(urlFinal);
}

/**
 * Ordena as fontes para que o arquivo .mp4 direto venha sempre em 1º lugar
 * e o HLS (.txt / format=m3u8) fique logo atrás como reserva automática!
 */
function ordenarFontesPreferenciais(fontesArray) {
  return fontesArray.sort((a, b) => {
    const aIsTxtHls = a.url.includes('master.txt') || a.url.includes('format=m3u8');
    const bIsTxtHls = b.url.includes('master.txt') || b.url.includes('format=m3u8');
    if (aIsTxtHls === bIsTxtHls) return 0;
    return aIsTxtHls ? 1 : -1;
  });
}

function extrairFontes(campos, bases) {
  const fontes = [];
  const urlsVistas = new Set();

  for (let i = 1; i < campos.length; i++) {
    const campo = (campos[i] || '').trim();
    if (!campo) continue;

    if (campo.includes('=')) {
      const idxEq = campo.indexOf('=');
      const prefixo = campo.slice(0, idxEq).toLowerCase().trim();
      const resto = campo.slice(idxEq + 1).trim();
      const idioma = (prefixo === 'leg' || prefixo.includes('leg')) ? 'legendado' : 'dublado';

      for (const urlBruta of resto.split(',')) {
        const urlFinal = montarUrl(urlBruta, bases);
        if (urlFinal && !urlsVistas.has(urlFinal)) {
          urlsVistas.add(urlFinal);
          fontes.push({ url: urlFinal, idioma });
        }
      }
    }
  }
  return ordenarFontesPreferenciais(fontes);
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
 * 1. CANAIS: Lê catalogo.txt respeitando referer: e agente: para converter error.txt em HLS compatível
 */
async function processarCanais() {
  console.log('\n📺 1. Baixando e processando canais de canais-saimo.pages.dev...');
  const [catalogoTxt, canaisM3uTxt] = await Promise.all([
    fetchText(`${CANAIS_BASE_URL}/catalogo.txt`),
    fetchText(`${CANAIS_BASE_URL}/canais.txt`)
  ]);

  const canaisMap = new Map();
  let canalAtual = null;
  let ultimaFonteObj = null;

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
      const normKey = valor.toLowerCase().replace(/\s+hd$/i, '').trim();
      if (!canaisMap.has(normKey)) {
        canalAtual = {
          nome: valor,
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
        ultimaFonteObj = { rawUrl: valor, referer: '', ua: '' };
        canalAtual.fontesBrutas.push(ultimaFonteObj);
      } else {
        ultimaFonteObj = null;
      }
    } else if (ultimaFonteObj && chave === 'referer') {
      ultimaFonteObj.referer = valor;
    } else if (ultimaFonteObj && chave === 'agente') {
      ultimaFonteObj.ua = valor;
    }
  }

  // Adiciona fontes extras do canais.txt (M3U reserva)
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
        const normKey = pendente.nome.toLowerCase().replace(/\s+hd$/i, '').trim();
        if (canaisMap.has(normKey)) {
          const c = canaisMap.get(normKey);
          c.fontesBrutas.push({ rawUrl: linha, referer: '', ua: '' });
          if (!c.logo && pendente.logo) c.logo = pendente.logo;
        } else if (pendente.nome) {
          canaisMap.set(normKey, {
            nome: pendente.nome,
            logo: pendente.logo,
            categoria: pendente.categoria,
            fontesBrutas: [{ rawUrl: linha, referer: '', ua: '' }]
          });
        }
        pendente = null;
      }
    }
  }

  const canaisJSON = [];
  let contador = 0;

  for (const canal of canaisMap.values()) {
    const urlsConvertidas = [];
    for (const f of canal.fontesBrutas) {
      const u = normalizeHlsUrl(f.rawUrl, f.referer, f.ua);
      if (u && !urlsConvertidas.includes(u)) {
        urlsConvertidas.push(u);
      }
    }

    // Prioriza links .m3u8 diretos na frente e mantém os convertidos via proxy/error.txt como reserva!
    urlsConvertidas.sort((a, b) => {
      const aProxy = a.includes('play.saimotv.com/api/proxy');
      const bProxy = b.includes('play.saimotv.com/api/proxy');
      if (aProxy === bProxy) return 0;
      return aProxy ? 1 : -1;
    });

    if (urlsConvertidas.length > 0) {
      contador++;
      canaisJSON.push({
        id: contador.toString(),
        nome: canal.nome,
        categoria: canal.categoria,
        logo: canal.logo,
        urls: urlsConvertidas
      });
    }
  }

  saveJsonFile('canais_sm.json', canaisJSON);
}

/**
 * 2. CARREGA METADADOS DO ACERVO
 */
async function carregarMetadadosVOD() {
  console.log('\n🎬 2. Carregando índice, fichas (TMDB ID) e gêneros de filmes-saimo.pages.dev...');
  const [indiceTxt, fichasTxt, generosTxt, detalhesTxt] = await Promise.all([
    fetchText(`${FILMES_BASE_URL}/indice.txt`),
    fetchText(`${FILMES_BASE_URL}/fichas.txt`),
    fetchText(`${FILMES_BASE_URL}/generos.txt`),
    fetchText(`${FILMES_BASE_URL}/detalhes.txt`)
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

  const metaMap = new Map();
  const normKey = (tipo, tit) => `${tipo.toLowerCase()}|${tit.replace(/\s*\(\d{4}\)\s*$/, '').trim().toLowerCase()}`;

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

  return { bases, gavetas, metaMap, normKey };
}

/**
 * 3. COLETA FILMES E SÉRIES
 */
async function coletarVOD(bases, gavetas, metaMap, normKey) {
  const filmesCartoonzine = [];
  const seriesCartoonzine = [];

  console.log('\n🎥 3. Extraindo Filmes...');
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
      const tituloLimpo = tituloCompleto.replace(/\s*\(\d{4}\)\s*$/, '').trim();

      const fontesFilme = extrairFontes(campos, bases);
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

      filmesCartoonzine.push(movieObj);
    }
  }

  console.log('\n📺 4. Extraindo Séries com Temporadas e Episódios...');
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
                  ep.fontes = ordenarFontesPreferenciais(ep.fontes);
                  return ep;
                })
                .filter((ep) => ep.fontes.length > 0)
                .sort((a, b) => a.episode - b.episode)
            }))
            .filter((s) => s.episodes.length > 0);

          delete serieAtual.seasonsMap;
          if (serieAtual.seasons.length > 0) {
            seriesCartoonzine.push(serieAtual);
          }
        }
      };

      for (let linha of textoPedaco.split(/\r?\n/)) {
        linha = linha.trim();
        if (!linha || linha.startsWith('#')) continue;

        if (linha.startsWith('@')) {
          salvarSerieAtual();
          const camposCabecalho = linha.substring(1).split('\t');
          const tituloSerie = (camposCabecalho[0] || '').trim();
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
              const urlFinal = montarUrl(urlBruta, bases);
              if (urlFinal && !episodioExistente.fontes.some((f) => f.url === urlFinal)) {
                episodioExistente.fontes.push({ url: urlFinal, idioma });
              }
            }
          }
        }
      }
      salvarSerieAtual();
    }
  }

  return { filmesCartoonzine, seriesCartoonzine };
}

/**
 * 4. COLETA ANIMES E DORAMAS
 */
async function coletarRedeFlix(caminhoRelativo, catLabel, tipoMeta, bases, metaMap, normKey) {
  console.log(`\n✨ Extraindo ${catLabel} (${caminhoRelativo})...`);
  const texto = await fetchText(`${FILMES_BASE_URL}/${caminhoRelativo}`);
  if (!texto) return [];

  const listaFinal = [];
  let itemAtual = null;

  const salvarItemAtual = () => {
    if (itemAtual) {
      itemAtual.seasons = Object.keys(itemAtual.seasonsMap)
        .sort((a, b) => Number(a) - Number(b))
        .map((sNum) => ({
          season: parseInt(sNum, 10),
          episodes: itemAtual.seasonsMap[sNum]
            .map((ep) => {
              ep.fontes = ordenarFontesPreferenciais(ep.fontes);
              return ep;
            })
            .filter((ep) => ep.fontes.length > 0)
            .sort((a, b) => a.episode - b.episode)
        }))
        .filter((s) => s.episodes.length > 0);

      delete itemAtual.seasonsMap;
      if (itemAtual.seasons.length > 0) {
        listaFinal.push(itemAtual);
      }
    }
  };

  for (let linha of texto.split(/\r?\n/)) {
    linha = linha.trim();
    if (!linha || linha.startsWith('#')) continue;

    if (linha.startsWith('@')) {
      salvarItemAtual();
      const camposCabecalho = linha.substring(1).split('\t');
      const titulo = (camposCabecalho[0] || '').trim();
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
          const urlFinal = montarUrl(urlBruta, bases);
          if (urlFinal && !episodioExistente.fontes.some((f) => f.url === urlFinal)) {
            episodioExistente.fontes.push({ url: urlFinal, idioma });
          }
        }
      }
    }
  }
  salvarItemAtual();

  return listaFinal;
}

/**
 * 5. DESTAQUES (Com logo e bannerlogo do cache TMDB)
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
      const titulo = campos[1];
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
  console.log(`  [✓] listas/${filename} salvo (${items.length.toLocaleString('pt-BR')} registros)`);
}

(async () => {
  try {
    console.log('==========================================');
    console.log('🚀 CARTOONZINE SM SCRAPER + HLS CONVERTER');
    console.log('==========================================');

    await processarCanais();
    const { bases, gavetas, metaMap, normKey } = await carregarMetadadosVOD();

    const { filmesCartoonzine, seriesCartoonzine } = await coletarVOD(bases, gavetas, metaMap, normKey);
    const animes = await coletarRedeFlix('redeflix/links-animes.txt', 'Animes', 'a', bases, metaMap, normKey);
    const doramas = await coletarRedeFlix('redeflix/links-doramas.txt', 'Doramas', 'd', bases, metaMap, normKey);

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

    console.log('\n==========================================');
    console.log('✅ TUDO CONCLUÍDO COM SUCESSO!');
    console.log('==========================================');
  } catch (err) {
    console.error('❌ Erro fatal:', err);
    process.exit(1);
  }
})();
