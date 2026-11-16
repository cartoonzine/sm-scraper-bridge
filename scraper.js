const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CANAIS_BASE_URL = 'https://canais-saimo.pages.dev';
const FILMES_BASE_URL = 'https://filmes-saimo.pages.dev';
const OUTPUT_DIR = path.join(__dirname, 'listas');
const TMDB_IMG = 'https://image.tmdb.org/t/p/w500';

const http = axios.create({
  timeout: 30000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Accept': 'text/plain, */*'
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
 * Filtra links incompatíveis com o format-detector.js do Cartoonzine Ultra Player:
 * - Remove saimo-tv.pages.dev/api/stream
 * - Remove embedplayer2.xyz/.../master.txt
 */
function isValidMediaUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.trim();
  if (!u.startsWith('http://') && !u.startsWith('https://')) return false;
  if (
    u.includes('saimo-tv.pages.dev/api/') ||
    u.includes('/api/stream') ||
    u.includes('embedplayer2.xyz/') ||
    u.endsWith('/master.txt')
  ) {
    return false;
  }
  return true;
}

/**
 * Converte "0:302441" na URL completa usando as bases do indice.txt
 */
function montarUrl(valor, bases) {
  if (!valor) return null;
  const limpo = valor.trim();
  if (!limpo) return null;

  if (limpo.startsWith('http://') || limpo.startsWith('https://')) {
    return isValidMediaUrl(limpo) ? limpo : null;
  }

  const partesUrl = limpo.split(':');
  if (partesUrl.length < 2) return null;

  const numero = partesUrl[0].trim();
  const resto = partesUrl.slice(1).join(':').trim();
  const base = bases[numero];
  if (!base || !resto) return null;

  const baseFormatada = base.endsWith('/') ? base : `${base}/`;
  const urlFinal = resto.includes('.') ? `${baseFormatada}${resto}` : `${baseFormatada}${resto}.mp4`;

  return isValidMediaUrl(urlFinal) ? urlFinal : null;
}

/**
 * Extrai fontes no formato [{ url, idioma: "dublado" | "legendado" }]
 */
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
  return fontes;
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
 * 1. CANAIS: Gera canais_sm.json no formato { id, nome, categoria, logo, urls }
 */
async function processarCanais() {
  console.log('\n📺 1. Baixando e categorizando canais de canais-saimo.pages.dev...');
  const [catalogoTxt, canaisM3uTxt] = await Promise.all([
    fetchText(`${CANAIS_BASE_URL}/catalogo.txt`),
    fetchText(`${CANAIS_BASE_URL}/canais.txt`)
  ]);

  const canaisMap = new Map();
  let canalAtual = null;

  for (let linha of catalogoTxt.split(/\r?\n/)) {
    linha = linha.trim();
    if (!linha || linha.startsWith('#')) continue;

    const partes = linha.split(':');
    if (partes.length < 2) continue;

    const chave = partes.shift().trim().toLowerCase();
    const valor = partes.join(':').trim();
    if (!valor) continue;

    if (chave === 'canal') {
      const normKey = valor.toLowerCase().replace(/\s+hd$/i, '').trim();
      if (!canaisMap.has(normKey)) {
        canalAtual = {
          nome: valor,
          logo: '',
          categoria: classificarCanal(valor),
          urls: []
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
      if (isValidMediaUrl(valor) && !canalAtual.urls.includes(valor)) {
        canalAtual.urls.push(valor);
      }
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
          if (!c.urls.includes(linha)) c.urls.push(linha);
          if (!c.logo && pendente.logo) c.logo = pendente.logo;
        } else if (pendente.nome) {
          canaisMap.set(normKey, {
            nome: pendente.nome,
            logo: pendente.logo,
            categoria: pendente.categoria,
            urls: [linha]
          });
        }
        pendente = null;
      }
    }
  }

  const canaisJSON = [];
  let contador = 0;

  for (const canal of canaisMap.values()) {
    if (canal.urls.length > 0) {
      contador++;
      canaisJSON.push({
        id: contador.toString(),
        nome: canal.nome,
        categoria: canal.categoria,
        logo: canal.logo,
        urls: canal.urls
      });
    }
  }

  saveJsonFile('canais_sm.json', canaisJSON);
}

/**
 * 2. CARREGA METADADOS (indice.txt, fichas.txt, generos.txt, detalhes.txt)
 *    Inclui tmdbId para integração direta com o cz-info.js do player!
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

  // fichas.txt: tipo \t título \t id TMDB \t pôster \t gêneros
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
          const fullImg = posterPath.startsWith('http') ? posterPath : `${TMDB_IMG}${posterPath.startsWith('/') ? '' : '/'}${posterPath}`;
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

  console.log(`  [+] Bases carregadas: ${Object.keys(bases).length} | Fichas TMDB em cache: ${metaMap.size}`);
  return { bases, gavetas, metaMap, normKey };
}

/**
 * 3. PROCESSA FILMES E SÉRIES (Com tmdbId, tmdbTipo e Seasons -> Episodes -> Fontes)
 */
async function processarVOD(bases, gavetas, metaMap, normKey) {
  const filmesCartoonzine = [];
  const seriesCartoonzine = [];
  const adultosVodCartoonzine = [];

  // 3.1 FILMES
  console.log('\n🎥 3. Processando Filmes...');
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

  // 3.2 SÉRIES
  console.log('\n📺 4. Processando Séries com Temporadas e Episódios...');
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

  // 3.3 ADULTO VOD
  for (const g of gavetas) {
    const nomeArquivo = g.letra === '#' ? '%23' : g.letra;
    const textoAdulto = await fetchText(`${FILMES_BASE_URL}/reservado-${nomeArquivo}.txt`);
    if (!textoAdulto) continue;

    for (let linha of textoAdulto.split(/\r?\n/)) {
      linha = linha.trim();
      if (!linha || linha.startsWith('#')) continue;
      const campos = linha.split('\t');
      if (campos.length < 2 || !campos[0]) continue;

      const tituloCompleto = campos[0].trim();
      const fontesFilme = extrairFontes(campos, bases);
      if (fontesFilme.length === 0) continue;

      adultosVodCartoonzine.push({
        cat: 'Adulto VOD',
        title: tituloCompleto,
        desc: 'Conteúdo restrito para maiores de 18 anos.',
        thumb: '',
        bannerThumb: '',
        year: '',
        genre: 'Adulto',
        fontes: fontesFilme
      });
    }
  }

  saveJsonFile('filmes_sm.json', filmesCartoonzine);

  const tamanho = Math.ceil(seriesCartoonzine.length / 3) || 0;
  saveJsonFile('series_sm_pt1.json', seriesCartoonzine.slice(0, tamanho));
  saveJsonFile('series_sm_pt2.json', seriesCartoonzine.slice(tamanho, tamanho * 2));
  saveJsonFile('series_sm_pt3.json', seriesCartoonzine.slice(tamanho * 2));

  if (adultosVodCartoonzine.length > 0) {
    saveJsonFile('adultos_vod_sm.json', adultosVodCartoonzine);
  }
}

/**
 * 4. ANIMES E DORAMAS (Com seasons -> episodes -> fontes [{ url, idioma }] + tmdbId)
 */
async function processarRedeFlix(caminhoRelativo, catLabel, tipoMeta, nomeArquivoSaida, bases, metaMap, normKey) {
  console.log(`\n✨ Processando ${catLabel} (${caminhoRelativo})...`);
  const texto = await fetchText(`${FILMES_BASE_URL}/${caminhoRelativo}`);
  if (!texto) return;

  const listaFinal = [];
  let itemAtual = null;

  const salvarItemAtual = () => {
    if (itemAtual) {
      itemAtual.seasons = Object.keys(itemAtual.seasonsMap)
        .sort((a, b) => Number(a) - Number(b))
        .map((sNum) => ({
          season: parseInt(sNum, 10),
          episodes: itemAtual.seasonsMap[sNum]
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
      // Formato: @título \t ano \t id_tmdb
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

  saveJsonFile(nomeArquivoSaida, listaFinal);
}

/**
 * 5. DESTAQUES: Gera destaques_sm.json
 */
async function processarDestaques() {
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
      const tipo = campos[0] === 'f' ? 'Filme' : campos[0] === 's' ? 'Série' : campos[0] === 'a' ? 'Anime' : 'Dorama';
      const posterPath = campos[4];
      filaAtual.itens.push({
        tipo,
        titulo: campos[1],
        ano: campos[3],
        capa: posterPath ? (posterPath.startsWith('http') ? posterPath : capaBase + posterPath) : ''
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
  console.log(`  [✓] listas/${filename} gerado com sucesso (${items.length.toLocaleString('pt-BR')} registros)`);
}

(async () => {
  try {
    console.log('==========================================');
    console.log('🚀 CARTOONZINE SM SCRAPER BRIDGE');
    console.log('==========================================');

    await processarCanais();
    const { bases, gavetas, metaMap, normKey } = await carregarMetadadosVOD();
    await processarVOD(bases, gavetas, metaMap, normKey);
    await processarRedeFlix('redeflix/links-animes.txt', 'Animes', 'a', 'animes_sm.json', bases, metaMap, normKey);
    await processarRedeFlix('redeflix/links-doramas.txt', 'Doramas', 'd', 'doramas_sm.json', bases, metaMap, normKey);
    await processarDestaques();

    console.log('\n==========================================');
    console.log('✅ TUDO CONCLUÍDO COM SUCESSO!');
    console.log('==========================================');
  } catch (err) {
    console.error('❌ Erro fatal:', err);
    process.exit(1);
  }
})();
