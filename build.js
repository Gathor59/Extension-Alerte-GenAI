#!/usr/bin/env node
// Construit les paquets de l'extension à partir d'une seule source (la racine du dépôt):
//
//   dist/standard/   Chrome, Edge   (manifest.version = base)
//   dist/firefox/    Firefox
//   dist/safari/     Safari (macOS)
//
// Principe de parité: tout est copié à l'identique depuis la racine, seuls les manifestes (et les
// icônes Safari déclarées) diffèrent. Le script vérifie après coup, et échoue sinon.
//
// Usage:  node build.js            construit et vérifie
//         node build.js --check    vérifie uniquement (sans réécrire dist/)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');

// Fichiers et dossiers qui composent l'extension (tout ce qui est chargé par le navigateur)
const INCLUDE = [
  'manifest.json', 'service-worker.js', 'content.js', 'popup.html', 'popup.js', 'admin.html', 'admin.js',
  'i18n.js', 'styles.css', 'browser-polyfill.min.js', 'bloom-filter.json', 'idn-homographes.json',
  'icone-app_ia16.png', 'icone-app_ia32.png', 'icone-app_ia48.png', 'icone-app_ia64.png', 'icone-app_ia128.png',
  'locales'
];

// ── Delta de la version Safari: les icônes d'app plus grandes (générées depuis l'icône 128 px) ──
const SAFARI_FILES = [
  ['variants/safari/icone-app_ia256.png', 'icone-app_ia256.png'],
  ['variants/safari/icone-app_ia512.png', 'icone-app_ia512.png'],
  ['variants/safari/icone-app_ia1024.png', 'icone-app_ia1024.png']
];

// ── Delta de la version Firefox (la SEULE chose qui la distingue: le manifeste) ─────────────────
// Firefox ne supporte pas background.service_worker: il exécute les "scripts" comme une page de fond
// (une seule portée globale, sans importScripts), donc l'ordre est polyfill -> i18n -> service-worker.
// L'identifiant gecko est obligatoire en MV3 et DÉFINITIF une fois publié sur AMO (variants/firefox/gecko-id.txt).
// update_url est propre au Chrome Web Store; data_collection_permissions est exigé par AMO.
function firefoxManifest(base) {
  const m = JSON.parse(JSON.stringify(base));
  const idFile = path.join(ROOT, 'variants', 'firefox', 'gecko-id.txt');
  if (!fs.existsSync(idFile)) throw new Error('variants/firefox/gecko-id.txt manquant');
  const id = fs.readFileSync(idFile, 'utf8').trim();
  delete m.update_url;
  m.background = { scripts: ['browser-polyfill.min.js', 'i18n.js', 'service-worker.js'] };
  const gecko = Object.assign({}, (m.browser_specific_settings && m.browser_specific_settings.gecko) || {});
  gecko.id = id;
  // Données transmises uniquement sur action de l'utilisateur (formulaire de signalement): URL signalée et e-mail facultatif
  gecko.data_collection_permissions = { required: ['none'], optional: ['websiteActivity', 'personallyIdentifyingInfo'] };
  m.browser_specific_settings = { gecko };
  return m;
}

// ── Delta de la version Safari (la SEULE chose qui la distingue: le manifeste) ──────────────────
// Sources: page d'Apple "Assessing your Safari web extension's browser compatibility" et données MDN browser-compat-data.
//  - update_url: non supporté par Safari (les mises à jour passent par l'App Store)
//  - background.scripts: supporté depuis Safari 14, même ordre de chargement que Firefox (pas de importScripts)
//  - permissions.notifications: l'API notifications n'existe pas dans Safari
//  - browser_specific_settings.gecko: propre à Firefox, sans effet dans Safari
//  - Safari >= 15.4: première version avec action, action.default_popup et web_accessible_resources.matches/resources
//  - name: doit être IDENTIQUE au nom de l'app dans App Store Connect (sinon l'outil d'Apple refuse le paquet)
const SAFARI_NAME = 'Alerte sur les sites GenAI';
function safariManifest(base) {
  const m = JSON.parse(JSON.stringify(base));
  // Apple compare ce nom à celui de la fiche App Store Connect et refuse le paquet s'ils diffèrent
  m.name = SAFARI_NAME;
  delete m.update_url;
  m.background = { scripts: ['browser-polyfill.min.js', 'i18n.js', 'service-worker.js'] };
  m.permissions = (m.permissions || []).filter(p => p !== 'notifications');
  m.browser_specific_settings = { safari: { strict_min_version: '15.4' } };
  // Icônes plus grandes: l'app macOS que l'outil d'Apple fabriquera autour de l'extension en a besoin
  // (macOS exige un fichier par taille, contrairement à iOS) et l'App Store veut une icône 1024 px.
  m.icons = Object.assign({}, m.icons, { '256': 'icone-app_ia256.png', '512': 'icone-app_ia512.png', '1024': 'icone-app_ia1024.png' });
  return m;
}

// ── Utilitaires ─────────────────────────────────────────────────────────────────────────────────
function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }

function copyRecursive(src, dst) {
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    mkdirp(dst);
    for (const name of fs.readdirSync(src)) {
      if (name === 'README.md') continue; // documentation de dev, pas dans le paquet
      copyRecursive(path.join(src, name), path.join(dst, name));
    }
  } else {
    mkdirp(path.dirname(dst));
    fs.copyFileSync(src, dst);
  }
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) out.push(...listFiles(p, base));
    else out.push(path.relative(base, p).split(path.sep).join('/'));
  }
  return out.sort();
}

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function fail(msg) { console.error('\n✗ ' + msg); process.exit(1); }

// ── Construction ────────────────────────────────────────────────────────────────────────────────
function build() {
  for (const f of INCLUDE) {
    if (!fs.existsSync(path.join(ROOT, f))) fail(`fichier manquant à la racine: ${f}`);
  }
  const baseManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

  // On construit dans un dossier temporaire voisin, puis on remplace dist/ d'un coup.
  // Ainsi dist/standard ne sont JAMAIS vides ou incomplets pendant un build:
  // un navigateur qui a chargé ces dossiers ne voit pas "manifeste manquant ou illisible".
  const STAGING = DIST + '.tmp';
  rmrf(STAGING);
  for (const variant of ['standard', 'firefox', 'safari']) {
    const out = path.join(STAGING, variant);
    mkdirp(out);
    for (const f of INCLUDE) copyRecursive(path.join(ROOT, f), path.join(out, f));
  }

  // Version Firefox: même contenu, seul le manifeste change
  fs.writeFileSync(path.join(STAGING, 'firefox', 'manifest.json'), JSON.stringify(firefoxManifest(baseManifest), null, 2) + '\n');

  // Version Safari: même contenu, seul le manifeste change
  fs.writeFileSync(path.join(STAGING, 'safari', 'manifest.json'), JSON.stringify(safariManifest(baseManifest), null, 2) + '\n');
  for (const [src, dst] of SAFARI_FILES) {
    const from = path.join(ROOT, src);
    if (!fs.existsSync(from)) fail(`fichier de la version Safari manquant: ${src}`);
    fs.copyFileSync(from, path.join(STAGING, 'safari', dst));
  }


  // Échange: l'ancien dist/ est mis de côté puis supprimé, le nouveau prend sa place (deux renommages)
  const OLD = DIST + '.old';
  rmrf(OLD);
  if (fs.existsSync(DIST)) fs.renameSync(DIST, OLD);
  fs.renameSync(STAGING, DIST);
  rmrf(OLD);
}

// ── Vérification de parité ──────────────────────────────────────────────────────────────────────
function verify() {
  const std = path.join(DIST, 'standard');
  if (!fs.existsSync(std)) fail('dist/ absent: lancer "node build.js"');

  const problems = [];
  const stdFiles = listFiles(std);
  const ff = path.join(DIST, 'firefox');
  if (!fs.existsSync(ff)) fail('dist/firefox absent: lancer "node build.js"');
  const ffFiles = listFiles(ff);
  const mf = JSON.parse(fs.readFileSync(path.join(ff, 'manifest.json'), 'utf8'));
  const sf = path.join(DIST, 'safari');
  if (!fs.existsSync(sf)) fail('dist/safari absent: lancer "node build.js"');
  const sfFiles = listFiles(sf);
  const msf = JSON.parse(fs.readFileSync(path.join(sf, 'manifest.json'), 'utf8'));

  const ms = JSON.parse(fs.readFileSync(path.join(std, 'manifest.json'), 'utf8'));

  // 4) Les clés de langue sont les mêmes partout (pas de texte oublié dans une seule langue)
  const keys = (o, p = '') => Object.entries(o).flatMap(([k, v]) => v && typeof v === 'object' ? keys(v, p ? p + '.' + k : k) : [p ? p + '.' + k : k]);
  const fr = keys(JSON.parse(fs.readFileSync(path.join(std, 'locales/fr.json'), 'utf8'))).sort();
  const en = keys(JSON.parse(fs.readFileSync(path.join(std, 'locales/en.json'), 'utf8'))).sort();
  if (JSON.stringify(fr) !== JSON.stringify(en)) problems.push('locales/fr.json et locales/en.json n\'ont pas les mêmes clés');

  // 5) Tous les fichiers référencés par le manifeste existent dans chaque paquet
  for (const [name, dir, man] of [['standard', std, ms]]) {
    const refs = [man.background && man.background.service_worker, ...(man.content_scripts || []).flatMap(c => [...(c.js || []), ...(c.css || [])]),
      man.action && man.action.default_popup, man.options_ui && man.options_ui.page, ...Object.values(man.icons || {}), ...Object.values((man.action && man.action.default_icon) || {})].filter(Boolean);
    for (const r of refs) if (!fs.existsSync(path.join(dir, r))) problems.push(`${name}: fichier référencé par le manifeste introuvable: ${r}`);
  }

  // 6) Paquet Firefox: mêmes fichiers que le standard, hors manifeste, et manifeste = standard + delta Firefox
  const ffAdded = ffFiles.filter(f => !stdFiles.includes(f));
  const ffRemoved = stdFiles.filter(f => !ffFiles.includes(f));
  if (ffAdded.length) problems.push(`firefox: fichiers en trop par rapport au standard: ${ffAdded.join(', ')}`);
  if (ffRemoved.length) problems.push(`firefox: fichiers manquants par rapport au standard: ${ffRemoved.join(', ')}`);
  const ffDiffering = stdFiles.filter(f => ffFiles.includes(f) && f !== 'manifest.json' && sha(path.join(std, f)) !== sha(path.join(ff, f)));
  if (ffDiffering.length) problems.push(`firefox: fichiers qui divergent du standard (parité rompue): ${ffDiffering.join(', ')}`);
  const expectedFf = firefoxManifest(ms);
  if (JSON.stringify(mf) !== JSON.stringify(expectedFf)) problems.push('firefox: le manifeste n\'est pas exactement "standard + delta Firefox"');
  if (mf.version !== ms.version) problems.push(`firefox: version ${mf.version} différente du standard ${ms.version}`);
  if (mf.background.service_worker) problems.push('firefox: background.service_worker ne doit pas être présent (non supporté par Firefox)');
  if (mf.update_url) problems.push('firefox: update_url ne doit pas être présent');
  const ffScripts = (mf.background && mf.background.scripts) || [];
  if (ffScripts.indexOf('i18n.js') < 0 || ffScripts.indexOf('service-worker.js') < 0 || ffScripts.indexOf('i18n.js') > ffScripts.indexOf('service-worker.js')) problems.push('firefox: background.scripts doit lister i18n.js AVANT service-worker.js (sinon les traductions sont perdues)');
  // Formats d'identifiant acceptés par Firefox/AMO: GUID {...} ou chaîne de type e-mail (80 caractères max)
  const geckoId = mf.browser_specific_settings.gecko.id || '';
  const guidOk = /^\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$/.test(geckoId);
  const mailOk = /^[a-zA-Z0-9-._]*@[a-zA-Z0-9-._]+$/.test(geckoId) && geckoId.length <= 80;
  if (!guidOk && !mailOk) problems.push('firefox: gecko.id absent ou invalide');
  const idFromFile = fs.readFileSync(path.join(ROOT, 'variants', 'firefox', 'gecko-id.txt'), 'utf8').trim();
  if (geckoId !== idFromFile) problems.push(`firefox: gecko.id du manifeste (${geckoId}) différent de variants/firefox/gecko-id.txt (${idFromFile})`);
  for (const r of [...ffScripts, ...(mf.content_scripts || []).flatMap(c => [...(c.js || []), ...(c.css || [])]), mf.action && mf.action.default_popup, mf.options_ui && mf.options_ui.page, ...Object.values(mf.icons || {})].filter(Boolean)) {
    if (!fs.existsSync(path.join(ff, r))) problems.push(`firefox: fichier référencé par le manifeste introuvable: ${r}`);
  }

  // 7) Paquet Safari: mêmes fichiers que le standard, hors manifeste, et manifeste = standard + delta Safari
  // Le paquet Safari = standard + les fichiers déclarés dans SAFARI_FILES (icônes d'app macOS), rien d'autre
  const sfAddedExpected = SAFARI_FILES.map(([, dst]) => dst).sort();
  const sfAddedFound = sfFiles.filter(f => !stdFiles.includes(f)).sort();
  const sfRemoved = stdFiles.filter(f => !sfFiles.includes(f));
  if (JSON.stringify(sfAddedFound) !== JSON.stringify(sfAddedExpected)) problems.push(`safari: fichiers ajoutés inattendus: ${JSON.stringify(sfAddedFound)} (attendu ${JSON.stringify(sfAddedExpected)})`);
  if (sfRemoved.length) problems.push(`safari: fichiers manquants par rapport au standard: ${sfRemoved.join(', ')}`);
  const sfDiffering = stdFiles.filter(f => sfFiles.includes(f) && f !== 'manifest.json' && sha(path.join(std, f)) !== sha(path.join(sf, f)));
  if (sfDiffering.length) problems.push(`safari: fichiers qui divergent du standard (parité rompue): ${sfDiffering.join(', ')}`);
  if (JSON.stringify(msf) !== JSON.stringify(safariManifest(ms))) problems.push('safari: le manifeste n\'est pas exactement "standard + delta Safari"');
  if (msf.version !== ms.version) problems.push(`safari: version ${msf.version} différente du standard ${ms.version}`);
  if (msf.name !== SAFARI_NAME) problems.push(`safari: le nom du manifeste doit être exactement "${SAFARI_NAME}" (nom de la fiche App Store Connect), trouvé "${msf.name}"`);
  if (msf.update_url) problems.push('safari: update_url ne doit pas être présent (non supporté par Safari)');
  if (msf.background.service_worker) problems.push('safari: utiliser background.scripts (même ordre que Firefox), pas service_worker');
  if ((msf.permissions || []).includes('notifications')) problems.push('safari: la permission "notifications" ne doit pas être déclarée (API absente de Safari)');
  const sfScripts = (msf.background && msf.background.scripts) || [];
  if (sfScripts.indexOf('i18n.js') < 0 || sfScripts.indexOf('service-worker.js') < 0 || sfScripts.indexOf('i18n.js') > sfScripts.indexOf('service-worker.js')) problems.push('safari: background.scripts doit lister i18n.js AVANT service-worker.js');
  for (const r of [...sfScripts, ...(msf.content_scripts || []).flatMap(c => [...(c.js || []), ...(c.css || [])]), msf.action && msf.action.default_popup, msf.options_ui && msf.options_ui.page, ...Object.values(msf.icons || {})].filter(Boolean)) {
    if (!fs.existsSync(path.join(sf, r))) problems.push(`safari: fichier référencé par le manifeste introuvable: ${r}`);
  }
  if (problems.length) { console.error('\nParité NON respectée:'); problems.forEach(p => console.error('  ✗ ' + p)); process.exit(1); }

  console.log(`standard  ${ms.version.padEnd(10)} ${stdFiles.length} fichiers`);
  console.log(`firefox   ${mf.version.padEnd(10)} ${ffFiles.length} fichiers  (manifeste Firefox, id ${mf.browser_specific_settings.gecko.id})`);
  console.log(`safari    ${msf.version.padEnd(10)} ${sfFiles.length} fichiers  (manifeste Safari, Safari >= ${msf.browser_specific_settings.safari.strict_min_version}; + ${sfAddedFound.join(', ')})`);
  console.log(`✓ parité vérifiée: ${stdFiles.length - 1} fichiers identiques entre les 3 paquets, seuls les manifestes (et les icônes Safari déclarées) diffèrent`);
}

if (process.argv.includes('--check')) verify();
else { build(); verify(); }
