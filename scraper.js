const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://saimotv.com';
const OUTPUT_DIR = path.join(__dirname, 'listas');
const FALLBACK_FILMES_URL = 'https://raw.githubusercontent.com/cartoonzine/cartoonzine-sm-bridge/refs/heads/main/filmes_saimo.json';

const CHANNEL_ROUTES = [
  '/tv-ao-vivo',
  '/tv-ao-vivo/tv-aberta',
  '/tv-ao-vivo/esportes',
  '/tv-ao-vivo/filmes-e-series',
  '/tv-ao-vivo/noticias',
  '/tv-ao-vivo/infantil',
  '/tv-ao-vivo/documentarios',
  '/tv-ao-vivo/entretenimento',
  '/tv-ao-vivo/24-horas',
  '/tv-ao-vivo/musicas'
];

const http = axios.create({
  baseURL: BASE_URL,
  timeout: 20000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
  }
});

/**
 * Formata para o schema exato do seu sistema:
 * { cat, title, desc, thumb, bannerThumb, year, genre, fontes }
 */
function formatToCartoonzineSchema(raw, defaultCat = 'Filmes') {
  if (raw && Array.isArray(raw.fontes) && raw.title !== undefined && raw.thumb !== undefined) {
    return {
      cat: raw.cat || defaultCat,
      title: String(raw.title || '').trim(),
      desc: String(raw.desc || '').trim(),
      thumb: String(raw.thumb || '').trim(),
      bannerThumb: String(raw.bannerThumb || raw.thumb || '').trim(),
      year: String(raw.year || '').trim(),
      genre: String(raw.genre || defaultCat).trim(),
      fontes: raw.fontes
    };
  }

  const title = (
    raw.title || raw.name || raw.nome || raw.titulo || raw.tvg_name || raw.slug || ''
  ).toString().trim();

  let thumb = (
    raw.thumb || raw.poster || raw.posterUrl || raw.poster_path || raw.logo ||
    raw.image || raw.img || raw.capa || raw.tvg_logo || raw.icon || raw.cover || ''
  ).toString().trim();

  if (thumb.startsWith('/') && !thumb.startsWith('//')) {
    thumb = /^\/[a-zA-Z0-9]{20,}\.(jpg|png|webp)$/i.test(thumb)
      ? `https://image.tmdb.org/t/p/w500${thumb}`
      : `${BASE_URL}${thumb}`;
  }

  let bannerThumb = (
    raw.bannerThumb || raw.backdrop || raw.backdropUrl || raw.backdrop_path ||
    raw.banner || raw.fanart || raw.background || thumb || ''
  ).toString().trim();

  if (bannerThumb.startsWith('/') && !bannerThumb.startsWith('//')) {
    bannerThumb = `${BASE_URL}${bannerThumb}`;
  }

  const desc = (
    raw.desc || raw.description || raw.sinopse || raw.overview || raw.plot || raw.resumo || ''
  ).toString().trim();

  const year = (
    raw.year || raw.ano || raw.release_year ||
    (raw.release_date ? String(raw.release_date).slice(0, 4) : '') ||
    (raw.first_air_date ? String(raw.first_air_date).slice(0, 4) : '') || ''
  ).toString().trim();

  const genre = (
    Array.isArray(raw.genres) ? raw.genres.map(g => g.name || g).join(', ') :
    (raw.genre || raw.genero || raw.category || raw.categoria || raw.group || raw.group_title || defaultCat)
  ).toString().trim();

  const cat = (raw.cat || raw.type || raw.tipo || defaultCat).toString().trim();

  let fontes = [];
  if (Array.isArray(raw.fontes) && raw.fontes.length > 0) {
    fontes = raw.fontes;
  } else if (Array.isArray(raw.sources) && raw.sources.length > 0) {
    fontes = raw.sources;
  } else if (Array.isArray(raw.streams) && raw.streams.length > 0) {
    fontes = raw.streams;
  } else if (Array.isArray(raw.urls) && raw.urls.length > 0) {
    fontes = raw.urls;
  } else if (Array.isArray(raw.episodes) || Array.isArray(raw.episodios) || Array.isArray(raw.seasons)) {
    fontes = raw.episodes || raw.episodios || raw.seasons;
  } else {
    const singleUrl =
      raw.streamUrl || raw.stream_url || raw.stream || raw.m3u8 ||
      raw.videoUrl || raw.video || raw.embedUrl || raw.embed ||
      raw.url || raw.link || raw.src || raw.file || raw.href || '';
    if (singleUrl) {
      fontes = [singleUrl.startsWith('/') ? `${BASE_URL}${singleUrl}` : singleUrl];
    }
  }

  return { cat, title, desc, thumb, bannerThumb, year, genre, fontes };
}

/**
 * Extrai itens do HTML e do Payload RSC do Next.js
 */
function parseItemsFromHtmlOrRsc(rawText, categoryLabel) {
  const items = [];
  if (!rawText) return items;

  const unescaped = rawText
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');

  const objRegex = /\{[^{}]*?"(?:title|name|nome|titulo|slug)"\s*:\s*"[^"]+"[^{}]*\}/g;
  let m;
  while ((m = objRegex.exec(unescaped)) !== null) {
    try {
      const obj = JSON.parse(m[0]);
      const title = obj.title || obj.name || obj.nome || obj.titulo || '';
      if (!title || title.length < 2) continue;
      if (title === 'Saimo TV' || title.includes('Online Grátis')) continue;

      const slug = obj.slug || obj.id || '';
      let href = obj.url || obj.streamUrl || obj.stream || obj.href || '';
      if (!href && slug) {
        const prefix =
          categoryLabel === 'Canais' ? '/canal/' :
          categoryLabel === 'Filmes' ? '/filme/' :
          categoryLabel === 'Séries' ? '/serie/' :
          categoryLabel === 'Animes' ? '/anime/' : '/dorama/';
        href = `${BASE_URL}${prefix}${slug}`;
      }

      items.push({ ...obj, cat: categoryLabel, href });
    } catch (_) {}
  }

  const linkRegex = /<a[^>]+href="(\/(?:canal|filme|filmes|serie|series|anime|animes|dorama|doramas)\/[^"?#]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let lm;
  while ((lm = linkRegex.exec(rawText)) !== null) {
    const hrefPath = lm[1];
    if (hrefPath.includes('/pagina/')) continue;

    const innerHtml = lm[2];
    const imgMatch = innerHtml.match(/<img[^>]+src="([^"]+)"/i);
    const altMatch = innerHtml.match(/alt="([^"]+)"/i);
    const textClean = innerHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const yearMatch = textClean.match(/\b(19\d{2}|20\d{2})\b/);

    let title = (altMatch ? altMatch[1] : textClean).trim();
    if (!title) title = hrefPath.split('/').pop().replace(/-/g, ' ');

    let thumb = imgMatch ? imgMatch[1].replace(/&amp;/g, '&') : '';
    if (thumb.startsWith('/_next/image')) {
      const urlParam = thumb.match(/[?&]url=([^&]+)/);
      if (urlParam) thumb = decodeURIComponent(urlParam[1]);
    }

    items.push({
      cat: categoryLabel,
      title,
      thumb,
      year: yearMatch ? yearMatch[1] : '',
      genre: categoryLabel,
      href: `${BASE_URL}${hrefPath}`
    });
  }

  return items;
}

/**
 * Varre todas as páginas de uma categoria em alta concorrência (20 páginas simultâneas)
 */
async function scrapePaginatedCategory(basePath, categoryLabel, maxPages = 1700) {
  console.log(`\n=== EXTRAINDO CATEGORIA: ${categoryLabel} (${basePath}) ===`);
  const allCollected = [];
  const CONCURRENCY = 20;
  let emptyStreak = 0;

  for (let startPage = 1; startPage <= maxPages; startPage += CONCURRENCY) {
    const batchPages = [];
    for (let p = startPage; p < startPage + CONCURRENCY && p <= maxPages; p++) {
      batchPages.push(p);
    }

    const results = await Promise.all(
      batchPages.map(async (pageNum) => {
        const pageUrl = pageNum === 1 ? basePath : `${basePath}/pagina/${pageNum}`;
        try {
          const [htmlRes, rscRes] = await Promise.all([
            http.get(pageUrl).catch(() => ({ data: '' })),
            http.get(pageUrl, { headers: { 'RSC': '1' } }).catch(() => ({ data: '' }))
          ]);
          const combinedText = `${typeof htmlRes.data === 'string' ? htmlRes.data : JSON.stringify(htmlRes.data)}\n${typeof rscRes.data === 'string' ? rscRes.data : JSON.stringify(rscRes.data)}`;
          return parseItemsFromHtmlOrRsc(combinedText, categoryLabel);
        } catch (_) {
          return [];
        }
      })
    );

    let batchCount = 0;
    for (const pageItems of results) {
      if (pageItems.length > 0) {
        allCollected.push(...pageItems);
        batchCount += pageItems.length;
      }
    }

    if (startPage === 1 || startPage % 100 === 1 || batchCount === 0) {
      console.log(`  [Páginas ${batchPages[0]} a ${batchPages[batchPages.length - 1]}] -> +${batchCount} extraídos (Bruto acumulado: ${allCollected.length})`);
    }

    if (batchCount === 0) {
      emptyStreak++;
      if (emptyStreak >= 2) {
        console.log(`  [Fim da paginação de ${categoryLabel} na página ${batchPages[0]}]`);
        break;
      }
    } else {
      emptyStreak = 0;
    }
  }

  return deduplicate(allCollected.map(it => formatToCartoonzineSchema(it, categoryLabel)));
}

/**
 * Extrai todos os Canais ao Vivo e resolve os links de stream .m3u8 / proxy
 */
async function scrapeAllChannels() {
  console.log(`\n=== EXTRAINDO CANAIS AO VIVO ===`);
  const rawChannels = [];

  for (const route of CHANNEL_ROUTES) {
    try {
      const [htmlRes, rscRes] = await Promise.all([
        http.get(route).catch(() => ({ data: '' })),
        http.get(route, { headers: { 'RSC': '1' } }).catch(() => ({ data: '' }))
      ]);
      const text = `${htmlRes.data || ''}\n${rscRes.data || ''}`;
      const items = parseItemsFromHtmlOrRsc(text, 'Canais');
      console.log(`  [Rota ${route}] -> ${items.length} canais encontrados`);
      rawChannels.push(...items);
    } catch (_) {}
  }

  let channels = deduplicate(rawChannels.map(it => formatToCartoonzineSchema(it, 'Canais')));
  console.log(`  [Total de Canais Únicos]: ${channels.length}. Buscando streams M3U8...`);

  const BATCH = 20;
  for (let i = 0; i < channels.length; i += BATCH) {
    const slice = channels.slice(i, i + BATCH);
    await Promise.all(
      slice.map(async (ch) => {
        const chUrl = (ch.fontes && ch.fontes[0]) || '';
        if (!chUrl.includes('/canal/')) return;
        try {
          const pathOnly = chUrl.replace(BASE_URL, '');
          const [hRes, rRes] = await Promise.all([
            http.get(pathOnly).catch(() => ({ data: '' })),
            http.get(pathOnly, { headers: { 'RSC': '1' } }).catch(() => ({ data: '' }))
          ]);
          const raw = `${hRes.data || ''}\n${rRes.data || ''}`.replace(/\\"/g, '"');
          const m3u8Matches = raw.match(/https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/gi) || [];
          const proxyMatches = raw.match(/https?:\/\/play\.saimotv\.com\/api\/proxy\?[^"'\s\\]+/gi) || [];
          const embedMatches = raw.match(/https?:\/\/[^"'\s\\]*(?:embed|player)[^"'\s\\]*/gi) || [];

          const streams = [...new Set([...m3u8Matches, ...proxyMatches, ...embedMatches])].filter(
            u => !u.includes('error.txt') && !u.includes('googletagmanager')
          );
          if (streams.length > 0) {
            ch.fontes = streams;
          }
        } catch (_) {}
      })
    );
  }

  return channels;
}

/**
 * Deduplica preservando itens com mesmo nome mas links/anos diferentes
 */
function deduplicate(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it.title || it.title.length < 2) continue;
    const cleanTitle = it.title.toLowerCase().trim();
    if (cleanTitle === 'ao vivo' || cleanTitle === 'saimo tv' || cleanTitle === 'assistir') continue;
    const firstSource = (it.fontes && it.fontes[0]) ? String(it.fontes[0]).trim() : '';
    const key = firstSource ? `${firstSource}` : `${cleanTitle}|${it.year}|${it.cat}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

function saveJsonFile(filename, items) {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  const fullPath = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(fullPath, JSON.stringify(items, null, 2), 'utf-8');
  console.log(`  [✓] Arquivo listas/${filename} salvo com ${items.length.toLocaleString('pt-BR')} registros.`);
}

function saveSeriesIn3Parts(seriesArray) {
  const total = seriesArray.length;
  const partSize = Math.ceil(total / 3) || 0;
  saveJsonFile('series_sm_pt1.json', seriesArray.slice(0, partSize));
  saveJsonFile('series_sm_pt2.json', seriesArray.slice(partSize, partSize * 2));
  saveJsonFile('series_sm_pt3.json', seriesArray.slice(partSize * 2));
}

(async () => {
  try {
    // 1. CANAIS
    const canais = await scrapeAllChannels();
    saveJsonFile('canais_sm.json', canais);

    // 2. DORAMAS
    const doramas = await scrapePaginatedCategory('/doramas', 'Doramas', 40);
    saveJsonFile('doramas_sm.json', doramas);

    // 3. ANIMES
    const animes = await scrapePaginatedCategory('/animes', 'Animes', 100);
    saveJsonFile('animes_sm.json', animes);

    // 4. SÉRIES (Divididas em 3 partes)
    const series = await scrapePaginatedCategory('/series', 'Séries', 550);
    saveSeriesIn3Parts(series);

    // 5. FILMES (Até 1.700 páginas + mesclagem com base principal)
    let filmes = await scrapePaginatedCategory('/filmes', 'Filmes', 1700);
    try {
      const { data } = await axios.get(FALLBACK_FILMES_URL, { timeout: 30000 });
      if (Array.isArray(data)) {
        console.log(`  [+] Mesclando com ${data.length} filmes da base principal...`);
        const baseFormatted = data.map(it => formatToCartoonzineSchema(it, 'Filmes'));
        filmes = deduplicate([...filmes, ...baseFormatted]);
      }
    } catch (_) {}
    saveJsonFile('filmes_sm.json', filmes);

  } catch (err) {
    console.error('[Erro Fatal]:', err);
    process.exit(1);
  }
})();
