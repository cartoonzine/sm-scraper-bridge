const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const URL_CANAIS = 'https://canais-saimo.pages.dev/';
const URL_VOD = 'https://filmes-saimo.pages.dev/';

// Defina aqui se quer 'series_sm.json' (sem acento) ou 'séries_sm.json' (com acento)
const SERIES_FILENAME = 'series_sm.json';

/**
 * Converte qualquer objeto capturado para o formato exato do seu sistema:
 * { cat, title, desc, thumb, bannerThumb, year, genre, fontes }
 */
function formatToCartoonzineSchema(raw, defaultCat = 'Filmes') {
  const title = (
    raw.title || raw.name || raw.nome || raw.titulo || raw.tvg_name || ''
  ).toString().trim();

  const thumb = (
    raw.thumb || raw.poster || raw.logo || raw.image || raw.img || raw.capa ||
    raw.tvg_logo || raw.icon || raw.cover || raw.poster_path || ''
  ).toString().trim();

  const bannerThumb = (
    raw.bannerThumb || raw.backdrop || raw.banner || raw.fanart ||
    raw.backdrop_path || raw.background || thumb || ''
  ).toString().trim();

  const desc = (
    raw.desc || raw.description || raw.sinopse || raw.overview ||
    raw.plot || raw.resumo || ''
  ).toString().trim();

  const year = (
    raw.year || raw.ano || raw.release_year ||
    (raw.release_date ? String(raw.release_date).slice(0, 4) : '') || ''
  ).toString().trim();

  const genre = (
    raw.genre || raw.genero || raw.category || raw.categoria ||
    raw.group || raw.group_title || defaultCat
  ).toString().trim();

  const cat = (
    raw.cat || raw.type || raw.tipo || defaultCat
  ).toString().trim();

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
      raw.url || raw.stream || raw.stream_url || raw.link ||
      raw.src || raw.file || raw.m3u8 || raw.video || raw.play || '';
    if (singleUrl) {
      fontes = [singleUrl];
    }
  }

  return {
    cat,
    title,
    desc,
    thumb,
    bannerThumb,
    year,
    genre,
    fontes
  };
}

/**
 * Parser M3U / TXT
 */
function parseM3U(content, defaultCat = 'Canais') {
  const lines = content.split(/\r?\n/);
  const items = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
      const groupMatch = line.match(/group-title="([^"]*)"/i);
      const commaIdx = line.lastIndexOf(',');
      const title = commaIdx !== -1 ? line.slice(commaIdx + 1).trim() : 'Sem Título';
      const group = groupMatch ? groupMatch[1].trim() : defaultCat;

      current = {
        cat: defaultCat,
        title,
        desc: '',
        thumb: logoMatch ? logoMatch[1].trim() : '',
        bannerThumb: logoMatch ? logoMatch[1].trim() : '',
        year: '',
        genre: group,
        fontes: []
      };
    } else if (!line.startsWith('#') && current) {
      current.fontes = [line];
      items.push(current);
      current = null;
    }
  }
  return items;
}

/**
 * Extrator pesado: encontra arrays de objetos literais [{...},{...}] dentro de arquivos .js do Vite/Webpack
 */
function extractJsLiteralArrays(jsCode, sourceUrl) {
  const results = [];

  if (jsCode.includes('#EXTINF:')) {
    const m3u = parseM3U(jsCode);
    if (m3u.length > 0) {
      console.log(`    -> [+] M3U embutido em JS (${m3u.length} itens): ${sourceUrl}`);
      results.push(...m3u);
    }
  }

  // Procura padrões de início de array de objetos: `=[{` ou `: [{`
  const startRegex = /[=:]\s*\[\s*\{/g;
  let match;

  while ((match = startRegex.exec(jsCode)) !== null) {
    const bracketStart = jsCode.indexOf('[', match.index);
    if (bracketStart === -1) continue;

    let depth = 0;
    let inString = false;
    let stringChar = '';
    let escaped = false;
    let endIdx = -1;

    for (let i = bracketStart; i < jsCode.length; i++) {
      const ch = jsCode[i];

      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        escaped = true;
        continue;
      }
      if (inString) {
        if (ch === stringChar) inString = false;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inString = true;
        stringChar = ch;
        continue;
      }
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }

    if (endIdx !== -1 && (endIdx - bracketStart) > 500) {
      const arrayCandidate = jsCode.slice(bracketStart, endIdx + 1);
      try {
        // Avalia com segurança o literal de array extraído do bundle JS
        const evaluated = new Function(`return ${arrayCandidate}`)();
        if (Array.isArray(evaluated) && evaluated.length > 5 && typeof evaluated[0] === 'object') {
          const sample = evaluated[0];
          const keys = Object.keys(sample).join(',').toLowerCase();
          if (
            keys.includes('title') || keys.includes('name') || keys.includes('nome') ||
            keys.includes('titulo') || keys.includes('url') || keys.includes('stream') ||
            keys.includes('fontes') || keys.includes('logo') || keys.includes('thumb')
          ) {
            console.log(`    -> [+] Array JS Literal extraído (${evaluated.length} itens | chaves: ${keys.slice(0, 60)}): ${sourceUrl}`);
            results.push(...evaluated);
            // Avança o ponteiro do regex para depois desse array gigante
            startRegex.lastIndex = endIdx;
          }
        }
      } catch (_) {}
    }
  }

  return results;
}

/**
 * Classifica cada item entre filmes, series, animes ou doramas
 */
function classifyVodItem(raw) {
  const hint = `${raw._activeTab || ''} ${raw._sourceUrl || ''} ${raw._sourceKey || ''} ${raw.cat || ''} ${raw.type || ''} ${raw.tipo || ''}`.toLowerCase();
  const genreAndTitle = `${raw.genre || ''} ${raw.genero || ''} ${raw.group || ''} ${raw.category || ''} ${raw.categoria || ''} ${raw.title || ''} ${raw.name || ''} ${raw.nome || ''}`.toLowerCase();

  if (hint.includes('dorama') || genreAndTitle.includes('dorama') || genreAndTitle.includes('k-drama') || genreAndTitle.includes('coreano')) {
    return 'doramas';
  }
  if (hint.includes('anime') || genreAndTitle.includes('anime') || genreAndTitle.includes('crunchyroll') || genreAndTitle.includes('animação japonesa')) {
    return 'animes';
  }
  if (
    hint.includes('serie') ||
    hint.includes('série') ||
    genreAndTitle.includes('série') ||
    genreAndTitle.includes('serie') ||
    genreAndTitle.includes('temporada') ||
    /s\d{1,2}\s*e\d{1,2}/i.test(genreAndTitle) ||
    /t\d{1,2}\s*ep?\d{1,2}/i.test(genreAndTitle) ||
    raw.seasons ||
    raw.episodes ||
    raw.episodios
  ) {
    return 'series';
  }
  return 'filmes';
}

function deduplicate(items) {
  const seen = new Set();
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.title && (!it.fontes || it.fontes.length === 0)) continue;
    const key = `${it.title}|${it.cat}|${JSON.stringify(it.fontes[0] || '')}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

function saveJsonFile(filename, items) {
  const fullPath = path.join(__dirname, filename);
  fs.writeFileSync(fullPath, JSON.stringify(items, null, 2), 'utf-8');
  console.log(`  [✓] Arquivo ${filename} salvo com ${items.length.toLocaleString('pt-BR')} registros.`);
}

async function scrapeSite(browser, url, isVod = false) {
  console.log(`\n======================================================`);
  console.log(`ACESSANDO: ${url}`);
  console.log(`======================================================`);

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');

  const collected = [];
  let activeTab = '';

  page.on('response', async (res) => {
    const rUrl = res.url();
    const status = res.status();
    const cType = (res.headers()['content-type'] || '').toLowerCase();

    if (/\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|css)(\?|$)/i.test(rUrl) || rUrl.includes('tmdb.org/t/p') || rUrl.includes('fonts.')) {
      return;
    }

    console.log(`  [Rede ${status}] (${cType.split(';')[0] || 'unknown'}) -> ${rUrl}`);

    try {
      const text = await res.text();
      if (!text || text.length < 20) return;

      // 1. M3U direto
      if (text.includes('#EXTINF:')) {
        const parsed = parseM3U(text, isVod ? (activeTab || 'Filmes') : 'Canais');
        console.log(`    -> [+] M3U extraído (${parsed.length} itens)`);
        parsed.forEach(p => collected.push({ ...p, _sourceUrl: rUrl, _activeTab: activeTab }));
        return;
      }

      // 2. JSON direto
      const trimmed = text.trim();
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
          const json = JSON.parse(trimmed);
          if (Array.isArray(json) && json.length > 0) {
            console.log(`    -> [+] Array JSON (${json.length} itens)`);
            json.forEach(it => collected.push({ ...it, _sourceUrl: rUrl, _activeTab: activeTab }));
            return;
          } else if (json && typeof json === 'object') {
            for (const [k, v] of Object.entries(json)) {
              if (Array.isArray(v) && v.length > 0) {
                console.log(`    -> [+] Objeto JSON["${k}"] (${v.length} itens)`);
                v.forEach(it => collected.push({ ...it, _sourceUrl: rUrl, _sourceKey: k, _activeTab: activeTab }));
              }
            }
            return;
          }
        } catch (_) {}
      }

      // 3. Bundles JS ou HTML com scripts inline
      if (cType.includes('javascript') || cType.includes('html') || rUrl.endsWith('.js')) {
        const fromJs = extractJsLiteralArrays(text, rUrl);
        fromJs.forEach(it => collected.push({ ...it, _sourceUrl: rUrl, _activeTab: activeTab }));
      }
    } catch (_) {}
  });

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
  await new Promise(r => setTimeout(r, 6000));

  if (isVod) {
    const tabs = [
      { key: 'filmes', label: 'Filmes' },
      { key: 'series', label: 'Séries' },
      { key: 'animes', label: 'Animes' },
      { key: 'doramas', label: 'Doramas' }
    ];

    for (const t of tabs) {
      activeTab = t.key;
      console.log(`  [>] Clicando na aba: ${t.label}...`);
      await page.evaluate((lbl) => {
        const all = Array.from(document.querySelectorAll('div, button, a, span, li'));
        const el = all.find(node => (node.innerText || '').trim().startsWith(lbl) && (node.innerText || '').length < 45);
        if (el) el.click();
      }, t.label);
      await new Promise(r => setTimeout(r, 4000));
    }
  }

  // Diagnóstico do HTML renderizado
  const diag = await page.evaluate(() => ({
    title: document.title,
    scripts: Array.from(document.querySelectorAll('script[src]')).map(s => s.src),
    bodyPreview: (document.body?.innerText || '').slice(0, 500).replace(/\s+/g, ' ')
  }));

  console.log(`  [Diagnóstico] Título: "${diag.title}"`);
  console.log(`  [Diagnóstico] Scripts na página:`, diag.scripts);
  console.log(`  [Diagnóstico] Texto na tela: "${diag.bodyPreview}"`);

  await page.close();
  return collected;
}

(async () => {
  // Remove o arquivo duplicado com acento caso exista no repositório
  const duplicatePath = path.join(__dirname, 'séries_sm.json');
  if (SERIES_FILENAME !== 'séries_sm.json' && fs.existsSync(duplicatePath)) {
    fs.unlinkSync(duplicatePath);
    console.log('[Limpeza] Arquivo duplicado séries_sm.json removido.');
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const rawCanais = await scrapeSite(browser, URL_CANAIS, false);
    const canaisFormatted = deduplicate(
      rawCanais.map(item => formatToCartoonzineSchema(item, 'Canais'))
    );
    saveJsonFile('canais_sm.json', canaisFormatted);

    const rawVod = await scrapeSite(browser, URL_VOD, true);
    const buckets = { filmes: [], series: [], animes: [], doramas: [] };

    for (let i = 0; i < rawVod.length; i++) {
      const raw = rawVod[i];
      const category = classifyVodItem(raw);
      const labelMap = { filmes: 'Filmes', series: 'Séries', animes: 'Animes', doramas: 'Doramas' };
      buckets[category].push(formatToCartoonzineSchema(raw, labelMap[category]));
    }

    saveJsonFile('filmes_sm.json', deduplicate(buckets.filmes));
    saveJsonFile(SERIES_FILENAME, deduplicate(buckets.series));
    saveJsonFile('animes_sm.json', deduplicate(buckets.animes));
    saveJsonFile('doramas_sm.json', deduplicate(buckets.doramas));

  } catch (err) {
    console.error('[Erro Fatal]:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
