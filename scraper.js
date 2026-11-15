const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Referência para manter exatamente as mesmas chaves que o seu sistema lê
const REFERENCE_JSON_URL = 'https://raw.githubusercontent.com/cartoonzine/cartoonzine-sm-bridge/refs/heads/main/filmes_saimo.json';

const URL_CANAIS = 'https://canais-saimo.pages.dev/';
const URL_VOD = 'https://filmes-saimo.pages.dev/';

/**
 * 1. Detecta o schema de chaves do seu JSON original no GitHub
 */
async function getTargetSchema() {
  try {
    const { data } = await axios.get(REFERENCE_JSON_URL, { timeout: 15000 });
    const isRootArray = Array.isArray(data);
    const rootKey = !isRootArray ? Object.keys(data)[0] : null;
    const list = isRootArray ? data : (data[rootKey] || []);
    const sample = list[0] || {};
    console.log('[Schema Detectado]:', Object.keys(sample));
    return { isRootArray, rootKey, keys: Object.keys(sample), sample };
  } catch (_) {
    console.warn('[Aviso] Usando schema padrão.');
    return {
      isRootArray: true,
      rootKey: null,
      keys: ['id', 'title', 'logo', 'group', 'url'],
      sample: {}
    };
  }
}

/**
 * 2. Converte conteúdo M3U/TXT em objetos
 */
function parseM3U(content) {
  const lines = content.split(/\r?\n/);
  const items = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
      const groupMatch = line.match(/group-title="([^"]*)"/i);
      const idMatch = line.match(/tvg-id="([^"]*)"/i);
      const commaIdx = line.lastIndexOf(',');
      const title = commaIdx !== -1 ? line.slice(commaIdx + 1).trim() : 'Sem Título';

      current = {
        id: idMatch ? idMatch[1] : '',
        title,
        logo: logoMatch ? logoMatch[1] : '',
        group: groupMatch ? groupMatch[1] : 'Geral'
      };
    } else if (!line.startsWith('#') && current) {
      current.url = line;
      items.push(current);
      current = null;
    }
  }
  return items;
}

/**
 * 3. Classifica um item caso venha em um JSON único misturado
 */
function classifyCategory(raw, activeTabHint = '') {
  // Se a URL do JSON ou a aba clicada já indica a seção exata, prioriza ela
  const hint = `${activeTabHint} ${raw._sourceUrl || ''} ${raw._sourceKey || ''}`.toLowerCase();
  if (hint.includes('dorama')) return 'doramas';
  if (hint.includes('anime')) return 'animes';
  if (hint.includes('serie') || hint.includes('série')) return 'series';
  if (hint.includes('filme') || hint.includes('movie')) return 'filmes';

  const meta = `${raw.category || ''} ${raw.group || ''} ${raw.categoria || ''} ${raw.tipo || ''} ${raw.type || ''} ${raw.group_title || ''}`.toLowerCase();
  const title = `${raw.title || raw.name || raw.nome || raw.titulo || ''}`.toLowerCase();

  if (meta.includes('dorama') || meta.includes('k-drama') || meta.includes('coreano')) return 'doramas';
  if (meta.includes('anime') || meta.includes('animação japonesa') || meta.includes('crunchyroll')) return 'animes';
  if (
    meta.includes('série') ||
    meta.includes('serie') ||
    meta.includes('temporada') ||
    /s\d{1,2}\s*e\d{1,2}/i.test(title) ||
    /t\d{1,2}\s*ep?\d{1,2}/i.test(title) ||
    raw.seasons ||
    raw.episodes ||
    raw.episodios
  ) {
    return 'series';
  }
  return 'filmes';
}

/**
 * 4. Formata cada registro exatamente com as chaves do seu sistema
 */
function formatItem(raw, index, schema, defaultGroup) {
  const title = raw.title || raw.name || raw.nome || raw.titulo || raw.tvg_name || `Item ${index + 1}`;
  const logo = raw.logo || raw.poster || raw.image || raw.img || raw.capa || raw.tvg_logo || raw.icon || raw.thumb || '';
  const group = raw.group || raw.category || raw.categoria || raw.genero || raw.group_title || defaultGroup;
  const url = raw.url || raw.stream || raw.stream_url || raw.link || raw.src || raw.file || raw.m3u8 || raw.video || '';
  const id = raw.id || raw.tvg_id || `${index + 1}`;

  if (schema && schema.keys && schema.keys.length > 0) {
    const out = {};
    for (const key of schema.keys) {
      const k = key.toLowerCase();
      if (['id', 'tvg_id', 'codigo'].includes(k)) out[key] = id;
      else if (['title', 'name', 'nome', 'titulo', 'tvg_name'].includes(k)) out[key] = title;
      else if (['logo', 'poster', 'image', 'img', 'capa', 'icon', 'tvg_logo', 'thumb', 'cover'].includes(k)) out[key] = logo;
      else if (['group', 'category', 'categoria', 'genero', 'group_title', 'tipo', 'type'].includes(k)) out[key] = group;
      else if (['url', 'stream', 'stream_url', 'link', 'src', 'file', 'video'].includes(k)) out[key] = url;
      else if (raw[key] !== undefined) out[key] = raw[key];
      else out[key] = schema.sample[key] !== undefined ? schema.sample[key] : '';
    }
    return out;
  }

  return { id, title, logo, group, url };
}

/**
 * 5. Salva o JSON formatado no disco
 */
function saveJson(filename, items, schema) {
  if (!items || items.length === 0) {
    console.warn(`  [!] Lista vazia para ${filename}, mantendo arquivo anterior se existir.`);
    return;
  }
  const payload = schema.isRootArray ? items : { [schema.rootKey || 'items']: items };
  const fullPath = path.join(__dirname, filename);
  fs.writeFileSync(fullPath, JSON.stringify(payload, null, 2), 'utf-8');
  console.log(`  [✓] ${filename} salvo com ${items.length.toLocaleString('pt-BR')} títulos!`);
}

/**
 * Remove duplicados de forma super rápida para listas de +30.000 itens
 */
function deduplicateFast(items) {
  const seen = new Set();
  const result = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const uKey = `${item.title || item.name || item.nome || ''}|${item.url || item.stream || item.link || ''}`;
    if (!seen.has(uKey)) {
      seen.add(uKey);
      result.push(item);
    }
  }
  return result;
}

/**
 * 6. Extrai Canais de https://canais-saimo.pages.dev/
 */
async function scrapeCanais(browser, schema) {
  console.log(`\n=== EXTRAINDO CANAIS: ${URL_CANAIS} ===`);
  const page = await browser.newPage();
  const collected = [];

  page.on('response', async (res) => {
    const rUrl = res.url();
    const cType = (res.headers()['content-type'] || '').toLowerCase();
    if (/\.(png|jpg|jpeg|webp|svg|woff2?|css)$/i.test(rUrl)) return;

    try {
      if (cType.includes('json') || rUrl.endsWith('.json')) {
        const json = await res.json();
        const arr = Array.isArray(json) ? json : Object.values(json).find(v => Array.isArray(v));
        if (Array.isArray(arr) && arr.length > 0) {
          console.log(`  [+] JSON de Canais capturado (${arr.length} itens): ${rUrl}`);
          collected.push(...arr);
        }
      } else if (rUrl.endsWith('.m3u') || rUrl.endsWith('.m3u8') || rUrl.endsWith('.txt') || cType.includes('mpegurl')) {
        const txt = await res.text();
        if (txt.includes('#EXTINF:')) {
          const parsed = parseM3U(txt);
          console.log(`  [+] M3U de Canais capturado (${parsed.length} itens): ${rUrl}`);
          collected.push(...parsed);
        }
      }
    } catch (_) {}
  });

  await page.goto(URL_CANAIS, { waitUntil: 'networkidle2', timeout: 90000 });

  const memData = await page.evaluate(() => {
    const out = [];
    for (const k of Object.keys(window)) {
      try {
        const v = window[k];
        if (Array.isArray(v) && v.length > 2 && typeof v[0] === 'object' && v[0] !== null) {
          if (v[0].url || v[0].stream || v[0].link || v[0].name || v[0].title) out.push(...v);
        }
      } catch (_) {}
    }
    return out;
  });

  if (memData.length > 0) collected.push(...memData);
  await page.close();

  const formatted = deduplicateFast(
    collected.map((raw, i) => formatItem(raw, i, schema, 'Canais'))
  );
  saveJson('canais_sm.json', formatted, schema);
}

/**
 * 7. Extrai Filmes (31k+), Séries (9.9k+), Animes (1.3k+) e Doramas (264+) de https://filmes-saimo.pages.dev/
 */
async function scrapeVod(browser, schema) {
  console.log(`\n=== EXTRAINDO VOD (FILMES, SÉRIES, ANIMES, DORAMAS): ${URL_VOD} ===`);
  const page = await browser.newPage();

  let currentActiveTab = '';
  const rawItems = [];

  page.on('response', async (res) => {
    const rUrl = res.url();
    const cType = (res.headers()['content-type'] || '').toLowerCase();
    if (/\.(png|jpg|jpeg|webp|svg|woff2?|css)$/i.test(rUrl) || rUrl.includes('tmdb.org/t/p')) return;

    try {
      if (cType.includes('json') || rUrl.endsWith('.json')) {
        const json = await res.json();
        if (Array.isArray(json) && json.length > 0) {
          console.log(`  [+] Array JSON capturado (${json.length} itens) [Aba: ${currentActiveTab || 'Inicial'}]: ${rUrl}`);
          for (let i = 0; i < json.length; i++) {
            rawItems.push({ ...json[i], _sourceUrl: rUrl, _activeTab: currentActiveTab });
          }
        } else if (json && typeof json === 'object') {
          for (const [k, v] of Object.entries(json)) {
            if (Array.isArray(v) && v.length > 0) {
              console.log(`  [+] Objeto JSON["${k}"] capturado (${v.length} itens): ${rUrl}`);
              for (let i = 0; i < v.length; i++) {
                rawItems.push({ ...v[i], _sourceUrl: rUrl, _sourceKey: k, _activeTab: currentActiveTab });
              }
            }
          }
        }
      } else if (rUrl.endsWith('.m3u') || rUrl.endsWith('.m3u8') || rUrl.endsWith('.txt') || cType.includes('mpegurl')) {
        const txt = await res.text();
        if (txt.includes('#EXTINF:')) {
          const parsed = parseM3U(txt);
          console.log(`  [+] Lista M3U/TXT capturada (${parsed.length} itens) [Aba: ${currentActiveTab || 'Inicial'}]: ${rUrl}`);
          for (let i = 0; i < parsed.length; i++) {
            rawItems.push({ ...parsed[i], _sourceUrl: rUrl, _activeTab: currentActiveTab });
          }
        }
      }
    } catch (_) {}
  });

  await page.goto(URL_VOD, { waitUntil: 'networkidle2', timeout: 120000 });

  // Clica sequencialmente nos 4 cards da imagem: Filmes, Séries, Animes e Doramas
  const categoriesToClick = [
    { key: 'filmes', label: 'Filmes' },
    { key: 'series', label: 'Séries' },
    { key: 'animes', label: 'Animes' },
    { key: 'doramas', label: 'Doramas' }
  ];

  for (const cat of categoriesToClick) {
    currentActiveTab = cat.key;
    console.log(`  [>] Acionando aba: ${cat.label}...`);
    await page.evaluate((labelName) => {
      const elements = Array.from(document.querySelectorAll('div, button, a, span, h2, h3'));
      const target = elements.find(el => {
        const text = (el.innerText || '').trim();
        return text.startsWith(labelName) && text.length < 40;
      });
      if (target) target.click();
    }, cat.label);

    // Aguarda possíveis requisições de rede daquela aba terminarem
    await new Promise(r => setTimeout(r, 4000));
  }

  // Também verifica se o catálogo está em variáveis na memória (window ou IndexedDB)
  const windowCatalog = await page.evaluate(async () => {
    const extracted = [];
    for (const key of Object.keys(window)) {
      try {
        const val = window[key];
        if (Array.isArray(val) && val.length > 10 && typeof val[0] === 'object' && val[0] !== null) {
          extracted.push({ key, items: val });
        }
      } catch (_) {}
    }
    return extracted;
  });

  for (const group of windowCatalog) {
    console.log(`  [+] Variável window.${group.key} encontrada (${group.items.length} itens)`);
    for (const item of group.items) {
      rawItems.push({ ...item, _sourceKey: group.key });
    }
  }

  await page.close();

  // Separa nos 4 buckets: filmes, series, animes, doramas
  const buckets = {
    filmes: [],
    series: [],
    animes: [],
    doramas: []
  };

  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i];
    const cat = classifyCategory(raw, raw._activeTab);
    const formatted = formatItem(raw, i, schema, cat.toUpperCase());
    buckets[cat].push(formatted);
  }

  const filmesFinal = deduplicateFast(buckets.filmes);
  const seriesFinal = deduplicateFast(buckets.series);
  const animesFinal = deduplicateFast(buckets.animes);
  const doramasFinal = deduplicateFast(buckets.doramas);

  saveJson('filmes_sm.json', filmesFinal, schema);
  saveJson('series_sm.json', seriesFinal, schema);
  saveJson('séries_sm.json', seriesFinal, schema); // Salva também com acento conforme pedido
  saveJson('animes_sm.json', animesFinal, schema);
  saveJson('doramas_sm.json', doramasFinal, schema);
}

(async () => {
  const schema = await getTargetSchema();
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    await scrapeCanais(browser, schema);
    await scrapeVod(browser, schema);
  } catch (err) {
    console.error('[Erro durante a execução]:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
