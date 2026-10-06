require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
// IMPORTANT : le webhook Stripe a besoin du corps BRUT de la requête pour vérifier la signature.
// express.json() ne doit donc PAS s'appliquer à /webhook, sinon tous les paiements échouent à la vérification.
app.use((req, res, next) => {
  if (req.originalUrl === '/webhook') return next();
  express.json()(req, res, next);
});

const resend = new Resend(process.env.RESEND_API_KEY);

// ─── MÉMOIRE (CACHE) : même modèle → mêmes résultats, plus rapide et moins cher ───
// Fiabilité mémorisée 30 jours par modèle/moteur/année ; prix du marché 7 jours par modèle/année/tranche de km.
// Le fichier est conservé tant que le serveur tourne. Pour le garder aussi après un redéploiement,
// ajouter un volume Railway et la variable CACHE_DIR (ex : /data).
const fs = require('fs');
const path = require('path');
const CACHE_FILE = path.join(process.env.CACHE_DIR || __dirname, 'ecc-cache.json');
const CACHE_TTL = { fiabilite: 30 * 24 * 3600 * 1000, marche: 7 * 24 * 3600 * 1000 };
let cache = { fiabilite: {}, marche: {} };
try {
  if (fs.existsSync(CACHE_FILE)) {
    cache = { fiabilite: {}, marche: {}, ...JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) };
    console.log(`CACHE chargé : ${Object.keys(cache.fiabilite).length} modèle(s) fiabilité, ${Object.keys(cache.marche).length} prix marché`);
  }
} catch (e) { console.log('CACHE illisible, on repart à zéro:', e.message); }
let cacheTimer = null;
function sauverCache() {
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => {
    try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache)); } catch (e) { console.log('CACHE sauvegarde impossible:', e.message); }
  }, 500);
}
function cacheLire(type, cle) {
  const e = cache[type][cle];
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL[type]) { delete cache[type][cle]; sauverCache(); return null; }
  return e.data;
}
function cacheEcrire(type, cle, data) {
  cache[type][cle] = { ts: Date.now(), data };
  sauverCache();
}
const cleNorm = (...parts) => parts.map(p => String(p || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9.]+/g, ' ').trim()).join('|');

// Protection des routes de test : sans la bonne clé, personne ne peut générer de rapport gratuit à vos frais.
function exigerCleAdmin(req, res, next) {
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Accès refusé' });
  }
  next();
}

// ─── MARQUES CONNUES (multi-mots en premier pour éviter "alfa" seul) ─────
const MARQUES = [
  'Alfa Romeo', 'Aston Martin', 'Land Rover', 'Range Rover', 'Rolls-Royce', 'Mercedes-Benz', 'Lynk & Co',
  'Abarth', 'Alpine', 'Audi', 'Bentley', 'BMW', 'BYD', 'Cadillac', 'Chevrolet', 'Chrysler', 'Citroën', 'Citroen',
  'Cupra', 'Dacia', 'Dodge', 'DS', 'Ferrari', 'Fiat', 'Ford', 'Genesis', 'Honda', 'Hyundai', 'Infiniti', 'Isuzu',
  'Jaguar', 'Jeep', 'Kia', 'Lamborghini', 'Lancia', 'Lexus', 'Lotus', 'Maserati', 'Mazda', 'McLaren', 'Mercedes',
  'MG', 'Mini', 'Mitsubishi', 'Nissan', 'Opel', 'Peugeot', 'Polestar', 'Porsche', 'Renault', 'Seat', 'Skoda',
  'Smart', 'SsangYong', 'Subaru', 'Suzuki', 'Tesla', 'Toyota', 'Volkswagen', 'VW', 'Volvo'
];

// Marque depuis l'URL AutoScout24 : /fr/d/<marque>-<modele>-...-<id>
function marqueDepuisUrl(url) {
  const slug = (url.match(/\/d\/([^/?#]+)/) || [])[1];
  if (!slug) return '';
  const s = slug.toLowerCase();
  for (const m of MARQUES) {
    const key = m.toLowerCase().replace(/ë/g, 'e').replace(/&/g, '').replace(/[\s-]+/g, '-');
    if (s === key || s.startsWith(key + '-')) return m === 'VW' ? 'Volkswagen' : m;
  }
  return '';
}

// Lit les blocs <script type="application/ld+json"> (format schema.org) et renvoie les infos du véhicule.
// Ne renvoie QUE ce qui est réellement écrit dans l'annonce.
function extraireVehiculeJsonLd(html) {
  const blocs = [...html.matchAll(/<script[^>]*type=\\?["']?application\/ld\+json\\?["']?[^>]*>([\s\S]*?)<\/script>/gi)];
  if (blocs.length === 0) {
    const i = html.indexOf('application/ld+json');
    if (i !== -1) console.log('JSON-LD contexte (format inattendu):', html.substring(Math.max(0, i - 60), i + 160).replace(/\s+/g, ' '));
  }
  const objets = [];
  const aplatir = (o) => {
    if (!o) return;
    if (Array.isArray(o)) return o.forEach(aplatir);
    if (typeof o === 'object') {
      objets.push(o);
      if (o['@graph']) aplatir(o['@graph']);
      if (o.itemOffered) aplatir(o.itemOffered);
    }
  };
  for (const b of blocs) {
    const brut = b[1].trim().replace(/^<!\[CDATA\[|\]\]>$/g, '');
    try { aplatir(JSON.parse(brut)); continue; } catch (e) {}
    try { aplatir(JSON.parse(brut.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/[\r\n\t]+/g, ' '))); }
    catch (e) { console.log('JSON-LD bloc illisible:', e.message.substring(0, 80)); }
  }
  const estVehicule = (o) => {
    const t = [].concat(o['@type'] || []).join(' ');
    return /Car|Vehicle|Motorcycle/i.test(t) || (o.brand && (o.mileageFromOdometer || o.vehicleModelDate || o.model));
  };
  const v = objets.find(estVehicule);
  if (!v) return null;

  const texte = (x) => (x == null ? '' : typeof x === 'object' ? (x.name || x.value || '') : String(x)).toString().trim();
  const nombre = (x) => {
    const n = parseInt(String(texte(x)).replace(/[^\d]/g, ''), 10);
    return isNaN(n) ? null : n;
  };
  const offre = [].concat(v.offers || [])[0] || {};
  const r = {};
  const marque = texte(v.brand) || texte(v.manufacturer);
  if (marque) r.marque = marque;
  const modele = texte(v.model);
  if (modele) r.modele = modele;
  const annee = nombre(v.vehicleModelDate) || nombre(String(texte(v.productionDate) || texte(v.dateVehicleFirstRegistered)).slice(0, 4));
  if (annee && annee > 1950 && annee < 2100) r.annee = annee;
  const km = nombre(v.mileageFromOdometer);
  if (km && km > 0 && km < 2000000) r.km = km;
  const prix = nombre(offre.price || (offre.priceSpecification && offre.priceSpecification.price));
  if (prix && prix > 500) r.prix = prix;
  if (texte(v.color)) r.couleur = texte(v.color);
  if (texte(v.fuelType)) r.carburant = texte(v.fuelType);
  if (texte(v.vehicleTransmission)) r.boite = texte(v.vehicleTransmission);
  if (texte(v.driveWheelConfiguration)) r.transmission = texte(v.driveWheelConfiguration);
  const moteur = [].concat(v.vehicleEngine || [])[0];
  if (moteur && moteur.enginePower) r.puissance = texte(moteur.enginePower) + (moteur.enginePower.unitText ? ' ' + moteur.enginePower.unitText : '');
  const co2 = nombre(v.emissionsCO2);
  if (co2 && co2 < 1000) r.co2 = co2;
  if (texte(v.vehicleIdentificationNumber)) r.vin = texte(v.vehicleIdentificationNumber);
  return r;
}

// Répare les caractères Windows-1252 mal encodés (ex : "l\u0092avant" → "l’avant")
function reparerCaracteres(txt) {
  if (!txt) return txt;
  return String(txt)
    .replace(/[\u0091\u0092]/g, '’')
    .replace(/[\u0093\u0094]/g, '"')
    .replace(/[\u0096\u0097]/g, '–')
    .replace(/\u0085/g, '…')
    .replace(/[\u0080-\u009F]/g, '');
}

// Lecture tolérante des champs schema.org directement dans le texte de la page
// (utile quand le bloc JSON-LD n'est pas lisible en entier).
function extraireChampsSchema(html) {
  const r = {};
  const g = (re) => { const m = html.match(re); return m ? m[1].trim() : null; };
  const annee = g(/"(?:vehicleModelDate|productionDate|dateVehicleFirstRegistered|modelDate)"\s*:\s*"?(\d{4})/);
  if (annee && +annee > 1950 && +annee < 2100) r.annee = +annee;
  const co2 = g(/"emissionsCO2"\s*:\s*"?(\d{2,3})/);
  if (co2) r.co2 = +co2;
  const carb = g(/"fuelType"\s*:\s*"([^"]{2,30})"/);
  if (carb) r.carburant = carb;
  const boite = g(/"vehicleTransmission"\s*:\s*"([^"]{2,40})"/);
  if (boite) r.boite = boite;
  const traction = g(/"driveWheelConfiguration"\s*:\s*"([^"]{2,40})"/);
  if (traction) r.transmission = traction.replace(/^https?:\/\/schema\.org\//, '');
  const vin = g(/"vehicleIdentificationNumber"\s*:\s*"([A-HJ-NPR-Z0-9]{17})"/);
  if (vin) r.vin = vin;
  return r;
}

// ─── SCRAPING ───────────────────────────────────────────
async function scrapeAnnonce(url, langue = 'fr') {
  // Forcer la langue dans l'URL AutoScout24
  const langMap = { fr: 'fr', de: 'de', it: 'it', en: 'en' };
  const targetLang = langMap[langue] || 'fr';
  url = url.replace(/autoscout24\.ch\/(fr|de|it|en)\//, `autoscout24.ch/${targetLang}/`);
  try {
    // Appel principal HTML
    const response = await axios.get('https://api.zenrows.com/v1/', {
      params: {
        apikey: process.env.ZENROWS_API_KEY,
        url: url,
        js_render: 'true',
        premium_proxy: 'true',
        wait: '8000'
      },
      timeout: 120000
    });
    let html = response.data;
    if (typeof html !== 'string') html = JSON.stringify(html);
    html = reparerCaracteres(html);

    // Extraire les donnees structurees Next.js AVANT de supprimer les scripts
    let equipmentData = '';

    // Appel CSS extractor pour les équipements (toujours présent sur toutes les annonces)
    let cssEquipments = [];
    let cssCouleur = null;
    let cssDescVendeur = null;
    try {
      const cssResponse = await axios.get('https://api.zenrows.com/v1/', {
        params: {
          apikey: process.env.ZENROWS_API_KEY,
          url: url,
          js_render: 'true',
          premium_proxy: 'true',
          wait: '8000',
          css_extractor: JSON.stringify({
            equipments: '#expandable-equipment li.chakra-list__item',
            couleur_ext: '[data-testid="color-exterior"] span, [data-testid="color-exterior"], [data-testid="exterior-color"] span, [data-testid="exterior-color"]',
            description_vendeur: '[data-testid="description-content"], [data-testid="seller-comment"], [data-testid="clp-description"], [class*="description-content"]'
          })
        },
        timeout: 120000
      });
      const cssData = cssResponse.data;
      if (cssData && cssData.equipments && Array.isArray(cssData.equipments)) {
        setLangue(langue || 'fr');
        cssEquipments = cssData.equipments.filter(e => e && e.trim().length > 2);
        console.log('CSS EXTRACTOR équipements:', cssEquipments.length);
      }
      // Stocker couleur et description pour injection après equipmentData
      if (cssData && cssData.couleur_ext) {
        const v = Array.isArray(cssData.couleur_ext) ? cssData.couleur_ext[0] : cssData.couleur_ext;
        if (v && v.trim().length > 1) cssCouleur = v.trim();
      }
      if (cssData && cssData.description_vendeur) {
        const v = Array.isArray(cssData.description_vendeur) ? cssData.description_vendeur[0] : cssData.description_vendeur;
        if (v && v.trim().length > 30) cssDescVendeur = v.trim();
      }
    } catch(e) {
      console.log('CSS extractor erreur:', e.message);
    }
    let co2Value = null;
    let optionsList = [];
    // Données de base lues directement dans l'annonce (source de vérité, jamais inventées)
    const infos = {};

    try {
      // ── MÉTHODE 1: JSON échappé \"optional\":[ dans scripts Next.js (format ZenRows) ──
      const escapedOptIdx = html.indexOf('\\"optional\\":[');
      const escapedSearchIdx = html.indexOf('\\"searchAttributes\\"');
      if (escapedOptIdx !== -1 && escapedSearchIdx !== -1 && escapedSearchIdx > escapedOptIdx) {
        const optSection = html.substring(escapedOptIdx, escapedSearchIdx);
        const matches = [...optSection.matchAll(/\\"name\\":\\"([^\\"]+)\\"/g)];
        const names = matches.map(m => m[1]).filter(n => !n.includes('Détails consultez') && !n.includes('Details siehe') && n.length > 2);
        optionsList = [...new Set(names)];
        if (optionsList.length > 0) equipmentData += "\nOPTIONS_OPT (" + optionsList.length + "): " + optionsList.join(" | ");
      }
      const escapedStdIdx = html.indexOf('\\"standard\\":[');
      const escapedOptIdx2 = html.indexOf('\\"optional\\":[');
      if (escapedStdIdx !== -1 && escapedOptIdx2 !== -1 && escapedOptIdx2 > escapedStdIdx) {
        const stdSection = html.substring(escapedStdIdx, escapedOptIdx2);
        const matches = [...stdSection.matchAll(/\\"name\\":\\"([^\\"]+)\\"/g)];
        const names = matches.map(m => m[1]).filter(n => !n.includes('Aucune garantie') && !n.includes('Details') && !n.includes('Détails') && n.length > 2);
        const uniqueStd = [...new Set(names)];
        if (uniqueStd.length > 0) {
          optionsList = [...new Set([...optionsList, ...uniqueStd])];
          equipmentData += "\nOPTIONS_STD (" + uniqueStd.length + "): " + uniqueStd.join(" | ");
        }
      }

      // ── MÉTHODE 2: <li class="chakra-list__item"> (fallback) ──
      if (optionsList.length === 0) {
        const liMatches = [...html.matchAll(/<li class="chakra-list__item">([^<]+)<\/li>/g)];
        const liNames = liMatches.map(m => m[1].trim()).filter(n => n.length > 2);
        if (liNames.length > 0) {
          optionsList = [...new Set(liNames)];
          equipmentData += "\nOPTIONS_LI (" + optionsList.length + "): " + optionsList.join(" | ");
        }
      }

      // ── MÉTHODE 3: JSON non-échappé (ancien format) ──
      if (optionsList.length === 0) {
        const optionalIdx = html.indexOf('"optional":[');
        const searchAttrIdx = html.indexOf('"searchAttributes"');
        if (optionalIdx !== -1 && searchAttrIdx !== -1 && searchAttrIdx > optionalIdx) {
          const section = html.substring(optionalIdx, searchAttrIdx);
          const matches = [...section.matchAll(/"name":"([^"]+)"/g)];
          const names = matches.map(m => m[1]).filter(n => !n.includes('Détails consultez') && !n.includes('Details siehe') && n.length > 2);
          optionsList = [...new Set(names)];
          if (optionsList.length > 0) equipmentData += "\nOPTIONS_RAW (" + optionsList.length + "): " + optionsList.join(" | ");
        }
      }

      // ── MÉTHODE 4: searchAttributes depuis JSON Next.js (toujours présent) ──
      const saSection = html.match(/(?:\\"searchAttributes\\":|"searchAttributes":)\s*\[([^\]]{10,}?)\]/);
      if (saSection) {
        const saItems = [...saSection[1].matchAll(/(?:\\"|")([^"\\]+)(?:\\"|")/g)].map(m => m[1]);
        // Dictionnaire officiel AutoScout24 FR (extrait du JSON de la page)
        const saDict = {
          '360-camera': 'Caméra 360°', 'abs': 'ABS',
          'active-brake-assistant': 'Assistant de freinage automatique',
          'adaptive-cruise-control': 'Régulateur de vitesse adaptatif',
          'adaptive-headlights': 'Phares adaptatifs',
          'additional-instrumentation': 'Instruments supplémentaires',
          'air-condition': 'Climatisation', 'airbags': 'Airbags',
          'alarm-system': "Système d'alarme", 'alcantara': 'Alcantara',
          'alloy-wheels': 'Jantes en alliage', 'android-auto': 'Android Auto',
          'anti-theft-device': 'Dispositif antivol', 'apple-carplay': 'Apple CarPlay',
          'assisted-parking': 'Aide au parcage', 'audio-system': 'Système audio',
          'automatic-air-condition': 'Climatisation automatique',
          'backrest': 'Dossier', 'blind-spot-system': "Système d'angle mort",
          'bluetooth-interface': 'Interface Bluetooth', 'central-locking': 'Verrouillage centralisé',
          'cornering-light': 'Feux de virage', 'cruise-control': 'Régulateur de vitesse',
          'custom-exhaust': 'Échappement personnalisé', 'dab-radio': 'Radio numérique DAB',
          'differential-locking': 'Blocage de différentiel', 'drowsiness-detection': 'Détection de somnolence',
          'electric-seat': 'Réglage électrique des sièges', 'electric-tailgate': 'Hayon électrique',
          'electric-windows': 'Vitres électriques', 'esp': 'Contrôle de la stabilité (ESP)',
          'foglights': 'Phares antibrouillard', 'hands-free-set': 'Dispositif mains libres',
          'hardtop': 'Toit rigide', 'head-up-display': 'Affichage tête haute',
          'heated-seats': 'Sièges chauffants', 'isofix': 'ISOFIX',
          'keyless': 'Accès et démarrage sans clé', 'lane-assistant': 'Assistant de voie',
          'laser-headlights': 'Phares à Laser', 'leather-seats': 'Sièges en cuir',
          'led': 'Phares à LED', 'limited-slip-differential': 'Différentiel à glissement limité',
          'luggage-rack': 'Porte-bagages', 'navigation': 'Système de navigation intégré',
          'panorama-roof': 'Toit panoramique', 'parking-sensor-front': 'Capteurs de stationnement avant',
          'parking-sensor-rear': 'Capteurs de stationnement arrière',
          'partial-leather-seats': 'Sièges en cuir partiel', 'portable-navigation-system': 'Système de navigation portable',
          'power-steering': 'Direction assistée', 'rear-camera': 'Caméra arrière',
          'reinforced-suspension': 'Suspension renforcée', 'side-airbags': 'Airbags latéraux',
          'sliding-door': 'Porte coulissante', 'speaker': 'Haut-parleur',
          'sport-seats': 'Sièges sport', 'sport-suspension': 'Suspension sport',
          'start-stop-system': 'Système Start-Stop', 'sunroof': 'Toit ouvrant',
          'towbar': 'Rotule d attelage fixe', 'traction-control': 'Contrôle de traction',
          'traffic-sign-assistant': 'Assistant de signalisation routière',
          'traffic-sign-recognition': 'Reconnaissance des panneaux de signalisation',
          'ventilated-seats': 'Sièges ventilés', 'xenon-headlights': 'Phares au xénon',
          'adaptive-cruise-control': 'Régulateur de vitesse adaptatif',
        };
        const saNames = saItems.map(k => saDict[k]).filter(v => v);
        if (saNames.length > 0) {
          optionsList = [...new Set([...optionsList, ...saNames])];
          equipmentData += "\nSEARCH_ATTR (" + saNames.length + "): " + saNames.join(" | ");
          console.log("SEARCH_ATTR extraits:", saNames.length);
        }
      }

      // ── MÉTHODE 5: CSS Extractor ZenRows (le plus fiable) ──
      if (cssEquipments.length > 0) {
        const cssTranslated = cssEquipments.map(e => traduireOption(e)).filter(e => e !== null);
        optionsList = [...new Set([...cssTranslated, ...optionsList])];
        console.log("CSS_EXTRACTOR fusionné:", cssTranslated.length, "options");
      }

      console.log("OPTIONS EXTRAITES:", optionsList.length);

      // ── DONNÉES STRUCTURÉES schema.org (JSON-LD) : marque, modèle, année, km, prix, couleur… ──
      try {
        const ld = extraireVehiculeJsonLd(html);
        if (ld) {
          Object.assign(infos, ld);
          console.log('JSON-LD véhicule:', JSON.stringify(ld));
        } else {
          const nbBlocs = (html.match(/application\/ld\+json/gi) || []).length;
          console.log(`JSON-LD véhicule: aucun bloc lisible (${nbBlocs} bloc(s) ld+json dans la page)`);
        }
        const champs = extraireChampsSchema(html);
        for (const [k, v] of Object.entries(champs)) if (infos[k] == null) infos[k] = v;
        if (Object.keys(champs).length) console.log('CHAMPS schema.org (lecture directe):', JSON.stringify(champs));
      } catch (e) { console.log('JSON-LD erreur:', e.message); }
      // Marque depuis l'URL si toujours inconnue (ex: /d/alfa-romeo-giulia-...)
      if (!infos.marque) {
        const m = marqueDepuisUrl(url);
        if (m) { infos.marque = m; console.log('MARQUE depuis URL:', m); }
      }

      // CO2 — schema.org: "emissionsCO2":"210 g/km" OU JSON échappé \"co2Emission\":210
      const co2Match = html.match(/"emissionsCO2"\s*:\s*"?(\d{2,3})/) ||
                       html.match(/\\"emissionsCO2\\"\s*:\s*\\?"?(\d{2,3})/) ||
                       html.match(/\\"co2Emission\\"\s*:\s*(\d{2,3})/) ||
                       html.match(/\\"co2Emission\\":(\d+)/) ||
                       html.match(/"co2Emission":(\d+)/) ||
                       html.match(/"co2":(\d+)/);
      const weightMatch = html.match(/\\"weightTotal\\":(\d+)/) || html.match(/"weightTotal":(\d+)/);
      const listPriceMatch = html.match(/\\"listPrice\\":(\d+)/) || html.match(/"listPrice":(\d+)/);

      if (co2Match) {
        co2Value = parseInt(co2Match[1]);
        equipmentData += "\nCO2: " + co2Match[1] + " g/km";
      }
      if (weightMatch) equipmentData += "\nPOIDS TOTAL: " + weightMatch[1] + " kg";
      if (listPriceMatch) equipmentData += "\nPRIX CATALOGUE: " + listPriceMatch[1] + " CHF";

      // ── KILOMÉTRAGE depuis JSON structuré (avant truncation HTML) ──
      const kmJsonMatch = html.match(/\\"mileage\\":(\d+)/) || html.match(/"mileage":(\d+)/) ||
                          html.match(/\\"km\\":(\d+)/) || html.match(/"km":(\d+)/);
      if (kmJsonMatch) {
        const kmVal = parseInt(kmJsonMatch[1]);
        if (kmVal > 100 && kmVal < 2000000) {
          if (!infos.km) infos.km = kmVal;
          equipmentData += "\nKILOMÉTRAGE: " + kmVal.toLocaleString('fr-CH') + " km";
          console.log("KM EXTRAIT (JSON):", kmVal);
        }
      } else {
        // Fallback: regex sur le HTML brut avant truncation
        const kmRawMatch = html.match(/(\d[\d\s']{2,7})\s*km/i);
        if (kmRawMatch) {
          const kmVal = parseInt(kmRawMatch[1].replace(/[\s']/g, ''));
          if (kmVal > 100 && kmVal < 2000000) {
            equipmentData += "\nKILOMÉTRAGE: " + kmVal.toLocaleString('fr-CH') + " km";
            console.log("KM EXTRAIT (regex):", kmVal);
          }
        }
      }

      // ── ANNÉE depuis JSON structuré ──
      const anneeJsonMatch = html.match(/\\"firstRegistration\\":\\"?(\d{4})/) ||
                             html.match(/"firstRegistration":"?(\d{4})/) ||
                             html.match(/\\"year\\":(\d{4})/) || html.match(/"year":(\d{4})/);
      if (anneeJsonMatch) {
        if (!infos.annee) infos.annee = parseInt(anneeJsonMatch[1]);
        equipmentData += "\nANNÉE: " + anneeJsonMatch[1];
        console.log("ANNÉE EXTRAITE:", anneeJsonMatch[1]);
      }

      // ── PRIX DEMANDÉ depuis JSON structuré ──
      const prixJsonMatch = html.match(/\\"price\\":(\d{4,7})/) || html.match(/"price":(\d{4,7})/);
      if (prixJsonMatch) {
        const prixVal = parseInt(prixJsonMatch[1]);
        if (prixVal > 1000) {
          if (!infos.prix) infos.prix = prixVal;
          equipmentData += "\nPRIX DEMANDÉ: " + prixVal.toLocaleString('fr-CH') + " CHF";
          console.log("PRIX EXTRAIT (JSON):", prixVal);
        }
      }

      // LOG DEBUG couleur — extraire contexte autour des mots-clés couleur
      const colorIdx = html.search(/bodyColor|exteriorColor|\\\"color\\\":|\"color\":|couleur|farbe|colour/i);
      if (colorIdx > 0) console.log('DEBUG COULEUR contexte:', html.substring(Math.max(0,colorIdx-20), colorIdx+120).replace(/\s+/g,' '));
      else console.log('DEBUG COULEUR: aucun champ couleur trouvé dans le HTML');
      const sellerIdx = html.search(/sellerComment|freeText|Avis du fournisseur|Händlerkommentar/i);
      if (sellerIdx > 0) console.log('DEBUG DESC contexte:', html.substring(Math.max(0,sellerIdx-10), sellerIdx+200).replace(/\s+/g,' '));
      else console.log('DEBUG DESC: aucun sellerComment/freeText trouvé');

      // ── COULEUR depuis JSON structuré ou HTML ──
      // JSON structuré : champs spécifiques voiture (pas les couleurs CSS)
      // On essaie chaque motif dans l'ordre et on garde la PREMIÈRE valeur valide
      // (avant, un motif qui trouvait une valeur invalide bloquait tous les suivants).
      const motifsCouleur = [
        /"color"\s*:\s*"([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s\(\)\/\-]{1,40})"\s*,\s*"vehicleInteriorColor"/,
        /\\"color\\"\s*:\s*\\"([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s\(\)\/\-]{1,40})\\"\s*,\s*\\"vehicleInteriorColor\\"/,
        /\\"bodyColor\\"\s*:\s*\\"([^"\\]{2,40})\\"/,
        /"bodyColor"\s*:\s*"([^"\\]{2,40})"/,
        /\\"exteriorColor\\"\s*:\s*\\"([^"\\]{2,40})\\"/,
        /"exteriorColor"\s*:\s*"([^"\\]{2,40})"/,
        /\\"colour\\"\s*:\s*\\"([^"\\]{2,40})\\"/,
        /Ext[eé]rieure\s+([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s\(\)\/\-]{1,35})\s+Int[eé]rieure/i,
        /[Cc]ouleur\s+ext[eé]rieure\s*[:\-]?\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s\(\)\/\-]{1,35})/i
      ];
      const COULEURS_INVALIDES = ['extérieure', 'intérieure', 'couleur', 'exterior', 'interior', 'color', 'colour', 'inherit', 'transparent', 'currentcolor', 'none'];
      const COULEURS_TRAD = { black: 'Noir', white: 'Blanc', grey: 'Gris', gray: 'Gris', silver: 'Argent',
        red: 'Rouge', blue: 'Bleu', green: 'Vert', yellow: 'Jaune', orange: 'Orange',
        brown: 'Marron', beige: 'Beige', purple: 'Violet', pink: 'Rose', gold: 'Or' };
      let couleurVal = null;
      for (const motif of motifsCouleur) {
        const m = html.match(motif);
        if (!m) continue;
        const brut = m[1].replace(/\\"/g, '').trim();
        const val = COULEURS_TRAD[brut.toLowerCase()] || brut;
        if (val.length > 1 && !COULEURS_INVALIDES.includes(val.toLowerCase())) { couleurVal = val; break; }
      }
      if (couleurVal) {
        equipmentData += "\nCOULEUR: " + couleurVal;
        if (!infos.couleur) infos.couleur = couleurVal;
        console.log("COULEUR EXTRAITE:", couleurVal);
      } else {
        console.log("COULEUR: aucune valeur valide trouvée");
      }

      // ── DESCRIPTION VENDEUR depuis JSON structuré (avant truncation) ──
      // Chercher sellerComment (vraie description vendeur) en priorité, puis freeText
      const DISCLAIMERS_AS24 = [
        "l'équipement réel peut différer",
        "die tatsächliche ausstattung",
        "equipment may differ",
        "angaben ohne gewähr",
        "sous réserve de modifications",
        "les informations fournies"
      ];
      const cleanDesc = (raw) => {
        let t = raw.replace(/\\n/g, ' ').replace(/\\r/g, '').replace(/\\t/g, ' ')
          .replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\s{2,}/g, ' ').trim();
        const isDisclaimer = DISCLAIMERS_AS24.some(d => t.toLowerCase().includes(d));
        if (isDisclaimer || t.length < 30 || t.length > 5000 || t.startsWith('{') || t.startsWith('[')) return null;
        return t;
      };
      // Chercher sellerComment avec regex tolérante (contenu multiligne, caractères spéciaux)
      const sellerRaw = html.match(/sellerComment["']?\s*:\s*["']([\s\S]{30,3000}?)["']\s*[,}]/)?.[1] ||
                        html.match(/\\"sellerComment\\":\s*\\"((?:[^\\"\\\\]|\\\\.){30,3000})\\"/) ?.[1] ||
                        html.match(/"sellerComment"\s*:\s*"((?:[^"\\]|\\.){30,3000})"/) ?.[1] ||
                        html.match(/\\"freeText\\":\s*\\"((?:[^\\"\\\\]|\\\\.){30,3000})\\"/) ?.[1] ||
                        html.match(/"freeText"\s*:\s*"((?:[^"\\]|\\.){30,3000})"/) ?.[1];
      if (sellerRaw) {
        const t = cleanDesc(sellerRaw);
        if (t) { equipmentData += "\nDESCRIPTION_VENDEUR: " + t; console.log("DESCRIPTION VENDEUR (sellerComment):", t.substring(0, 100)); }
      }
      if (!equipmentData.includes('DESCRIPTION_VENDEUR:')) {
        const descMatch = html.match(/\\"description\\":\\"((?:[^\\"\\\\]|\\\\.|(?:\\\\u[0-9a-fA-F]{4}))+)\\"/) ||
                          html.match(/"description":"((?:[^"\\]|\\.)+)"(?:\s*,|\s*})/);
        if (descMatch) {
          const t = cleanDesc(descMatch[1]);
          if (t) { equipmentData += "\nDESCRIPTION_VENDEUR: " + t; console.log("DESCRIPTION VENDEUR EXTRAITE:", t.substring(0, 100)); }
          else console.log("DESCRIPTION VENDEUR ignorée (disclaimer):", descMatch[1].substring(0, 60));
        }
      }
      // ── DESCRIPTION VENDEUR depuis HTML rendu (fallback) ──
      if (!equipmentData.includes('DESCRIPTION_VENDEUR:')) {
        // AS24 affiche "Avis du fournisseur" ou "Seller comment" dans un bloc HTML
        // AS24: le bloc description vendeur est dans data-testid="description-content" ou class contenant "description"
        // Le titre "Avis du fournisseur" est séparé du contenu par plusieurs balises — ne pas se fier à lui
        const htmlDescMatch = html.match(/data-testid="(?:seller-comment|seller-notes|description-content|clp-description)"[^>]*>([\s\S]{30,3000}?)<\/(?:p|div|section)/i) ||
                              html.match(/class="[^"]*(?:seller-comment|sellerComment|description-text|description-content)[^"]*"[^>]*>([\s\S]{30,3000}?)<\/(?:p|div)/i) ||
                              html.match(/Händlerkommentar[^<]*<\/[^>]+>\s*(?:<[^>]+>\s*){1,5}([^<]{30,2000})/i);
        if (htmlDescMatch) {
          const t = cleanDesc(htmlDescMatch[1]);
          if (t) { equipmentData += "\nDESCRIPTION_VENDEUR: " + t; console.log("DESCRIPTION VENDEUR (HTML):", t.substring(0, 100)); }
        }
      }

      // Injecter couleur et description depuis CSS extractor (priorité sur regex HTML)
      if (cssCouleur && !equipmentData.includes('COULEUR:')) {
        equipmentData += "\nCOULEUR: " + cssCouleur;
        console.log('COULEUR CSS:', cssCouleur);
      } else if (cssCouleur) {
        console.log('COULEUR CSS (ignorée, déjà trouvée):', cssCouleur);
      }
      if (cssDescVendeur && !equipmentData.includes('DESCRIPTION_VENDEUR:')) {
        equipmentData += "\nDESCRIPTION_VENDEUR: " + cssDescVendeur;
        console.log('DESCRIPTION VENDEUR CSS:', cssDescVendeur.substring(0, 100));
      }

      console.log("CO2 EXTRAIT:", co2Value);
    } catch(e) {
      console.log("Extraction JSON echouee:", e.message);
    }

    // Nettoyer le HTML
    let cleanHtml = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    cleanHtml = cleanHtml.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    cleanHtml = cleanHtml.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, "");
    cleanHtml = cleanHtml.replace(/<[^>]+>/g, " ");
    cleanHtml = cleanHtml.replace(/\s+/g, " ").trim();

    // ── PUISSANCE et CO2 : données JSON de la page, sinon texte affiché de l'annonce (page complète, avant coupure) ──
    if (!infos.puissance) {
      const hp = html.match(/\\?"(?:horsePower|horsepower|powerHp|powerPS|hp)\\?"\s*:\s*\\?"?(\d{2,4})/);
      const kw = html.match(/\\?"(?:kiloWatts|kilowatts|powerKw|powerKW|kw)\\?"\s*:\s*\\?"?(\d{2,4})/);
      const txtPs = cleanHtml.match(/(?:Puissance|Leistung|Potenza|Power)[^\d]{0,25}(\d{2,4})\s*(?:PS|ch|CV|hp|HP)\b/i) ||
                    cleanHtml.match(/\b(\d{2,4})\s*kW\s*\(\s*(\d{2,4})\s*(?:PS|ch|CV)\s*\)/i);
      let ps = null;
      if (hp) ps = +hp[1];
      else if (txtPs) ps = +(txtPs[2] || txtPs[1]);
      else if (kw) ps = Math.round(+kw[1] * 1.36);
      if (ps && ps >= 40 && ps <= 2000) { infos.puissance = ps + ' PS'; console.log('PUISSANCE EXTRAITE:', infos.puissance); }
      else console.log('PUISSANCE: non trouvée dans l\'annonce');
    }
    if (!infos.co2) {
      const co2Txt = cleanHtml.match(/CO(?:2|₂)[^\d]{0,40}(\d{2,3})\s*g\s*\/\s*km/i);
      if (co2Txt) { infos.co2 = +co2Txt[1]; co2Value = co2Value || infos.co2; console.log('CO2 EXTRAIT (texte):', infos.co2); }
    }

    const finalContent = cleanHtml.substring(0, 15000);
    const titre = finalContent.split(/\s\*|\s(?:À vendre|Zu verkaufen|In vendita|For sale|Rechercher|Suchen|Cerca|Search|CHF)\b/)[0].trim();
    if (titre && titre.length >= 4 && titre.length <= 120) infos.titre = titre;
    console.log("ZENROWS OK:", finalContent.substring(0, 500));

    // FIX: retourner equipmentData, co2Value et optionsList avec le html
    if (co2Value && !infos.co2) infos.co2 = co2Value;
    // Lien "recherche du même modèle" présent sur la page (ex : /fr/s/mo-rs3/mk-audi) — sert aux annonces comparables
    const lienRech = html.match(/href=\\?["'](\/(?:fr|de|it|en)\/s\/mo-[a-z0-9-]+\/mk-[a-z0-9-]+)(?:[?"'\\])/i);
    if (lienRech) { infos.lienRecherche = lienRech[1]; console.log('LIEN RECHERCHE MODÈLE:', infos.lienRecherche); }
    const idAnnonce = (url.match(/-(\d{6,})(?:[/?#]|$)/) || [])[1];
    if (idAnnonce) infos.idAnnonce = idAnnonce;
    console.log('INFOS ANNONCE:', JSON.stringify(infos));
    return { html: finalContent, url: url, equipmentData: equipmentData, co2: co2Value, options: optionsList, infos };
  } catch (err) {
    console.log('ZENROWS ERROR:', err.response?.data || err.message);
    return { html: `URL: ${url}`, url: url, equipmentData: '', co2: null, options: [], infos: {}, erreurScraping: true };
  }
}

// ─── ESTIMATION TAXE ────────────────────────────────────
function estimerTaxe(co2, carburant) {
  if (!carburant) return 600;
  const isElectric = carburant.toLowerCase().includes('électr');
  if (isElectric) return 120;
  if (!co2 || co2 === 0) return 600;
  if (co2 <= 100) return 200;
  if (co2 <= 120) return 300;
  if (co2 <= 140) return 450;
  if (co2 <= 160) return 600;
  if (co2 <= 180) return 750;
  if (co2 <= 200) return 900;
  if (co2 <= 220) return 1100;
  if (co2 <= 250) return 1300;
  return 1500;
}

// ─── NETTOYAGE PUISSANCE ────────────────────────────────
function nettoyerPuissance(puissance) {
  if (!puissance) return puissance;
  return puissance.replace(/\s*\([\d\s\w]+\)\s*/g, '').replace(/PS\s*PS/g, 'PS').trim();
}

// ─── TRADUCTION OPTIONS ALLEMAND ────────────────────────
// Dictionnaire universel: clé allemande/française → traductions par langue
const OPTIONS_DICT = {
  // Null = à supprimer
  'Details siehe Preisliste': null,
  'Détails consultez la liste de prix': null,
  'Keine Gewähr auf die Angaben der Serienausstattungen': null,
  'Aucune garantie sur l exactitude de l équipement de série': null,

  // Termes allemands → traductions
  'Ambientebeleuchtung':           { fr: "Éclairage d'ambiance", de: "Ambientebeleuchtung", it: "Illuminazione ambientale", en: "Ambient lighting" },
  'Deaktivierung Beifahrerairbag': { fr: "Désactivation airbag passager", de: "Beifahrerairbag-Deaktivierung", it: "Disattivazione airbag passeggero", en: "Passenger airbag deactivation" },
  'Knieairbag Fahrer':             { fr: "Airbag genoux conducteur", de: "Knieairbag Fahrer", it: "Airbag ginocchio guidatore", en: "Driver knee airbag" },
  'Aussenspiegel elektrisch anklappbar': { fr: "Rétroviseurs électriques rabattables", de: "Elektrisch anklappbare Außenspiegel", it: "Specchietti elettrici ripiegabili", en: "Electric folding mirrors" },
  'Innen- und Fahreraussenspiegel automatisch abblendbar': { fr: "Rétroviseurs photochromatiques", de: "Automatisch abblendbare Spiegel", it: "Specchietti fotocromatici", en: "Auto-dimming mirrors" },
  'Sitzheizung vorne':             { fr: "Sièges avant chauffants", de: "Sitzheizung vorne", it: "Sedili anteriori riscaldati", en: "Front heated seats" },
  'Wireless Charging für mobile Geräte': { fr: "Chargement sans fil", de: "Kabelloses Laden", it: "Ricarica wireless", en: "Wireless charging" },
  'Dachhimmel schwarz/ Stoff':     { fr: "Ciel de toit noir / tissu", de: "Schwarzer Dachhimmel", it: "Cielo del tetto nero", en: "Black headliner" },
  'Dachhimmel schwarz':            { fr: "Ciel de toit noir", de: "Schwarzer Dachhimmel", it: "Cielo del tetto nero", en: "Black headliner" },
  'ESP Elektronisches Stabilitätsprogramm': { fr: "Contrôle ESP", de: "ESP", it: "Controllo ESP", en: "ESP stability control" },
  'LED Tagfahrlicht':              { fr: "Feux de jour LED", de: "LED-Tagfahrlicht", it: "Luci diurne LED", en: "LED daytime lights" },
  'Rückfahrkamera':                { fr: "Caméra de recul", de: "Rückfahrkamera", it: "Telecamera posteriore", en: "Rear camera" },
  'Reifendruck-Kontrollsystem RDK': { fr: "Contrôle pression pneus", de: "Reifendruckkontrolle", it: "Controllo pressione pneumatici", en: "Tyre pressure monitoring" },
  'Seitenairbag Fahrer und Beifahrerseite': { fr: "Airbags latéraux", de: "Seitenairbags", it: "Airbag laterali", en: "Side airbags" },
  'Airbag Fahrer und Beifahrerseite': { fr: "Airbags conducteur et passager", de: "Fahrer- und Beifahrerairbag", it: "Airbag guidatore e passeggero", en: "Driver and passenger airbags" },
  'Alarmanlage mit Abschleppschutz u. Innenraumabsicherung': { fr: "Alarme avec antivol", de: "Alarmanlage mit Abschleppschutz", it: "Allarme con protezione rimorchio", en: "Alarm with tow protection" },
  'Einbruch- und Diebstahlwarnanlage': { fr: "Système antivol", de: "Diebstahlwarnanlage", it: "Antifurto", en: "Anti-theft system" },
  'Soundsystem':                   { fr: "Système audio premium", de: "Soundsystem", it: "Sistema audio premium", en: "Premium sound system" },

  // Termes français → traductions
  'Éclairage d ambiance':          { fr: "Éclairage d'ambiance", de: "Ambientebeleuchtung", it: "Illuminazione ambientale", en: "Ambient lighting" },
  'Éclairage d\'ambiance intérieur': { fr: "Éclairage d'ambiance", de: "Ambientebeleuchtung", it: "Illuminazione ambientale", en: "Ambient lighting" },
  'Aileron arrière':               { fr: "Aileron arrière AMG", de: "AMG Heckspoiler", it: "Spoiler posteriore AMG", en: "AMG rear spoiler" },
  'Gilets de sécurité pour le conducteur et les passagers': { fr: "Ceintures de sécurité", de: "Sicherheitsgurte", it: "Cinture di sicurezza", en: "Seat belts" },
  'Intérieur MBUX Assist':         { fr: "Système MBUX", de: "MBUX System", it: "Sistema MBUX", en: "MBUX System" },
  'Distronic/ tempomat à réglage de distance': { fr: "Régulateur de distance adaptatif", de: "Distronic Abstandsregeltempomat", it: "Cruise control adattivo", en: "Adaptive cruise control" },

  // ─── TERMES ALLEMANDS BMW/AUDI/MERCEDES ───────────────
  'Ablagenpaket':                  { fr: "Pack rangements intérieur", de: "Ablagenpaket", it: "Kit vani portaoggetti", en: "Storage package" },
  'Adaptives Kurvenlicht':         { fr: "Phares adaptatifs en virage", de: "Adaptives Kurvenlicht", it: "Luci curve adattive", en: "Adaptive cornering lights" },
  'Adaptives variables Fahrwerk':  { fr: "Châssis adaptatif variable", de: "Adaptives variables Fahrwerk", it: "Telaio adattivo variabile", en: "Adaptive variable suspension" },
  'Active Protection':             { fr: "Système de protection active", de: "Active Protection", it: "Protezione attiva", en: "Active protection system" },
  'Alarmanlage mit Innenraumüberwachung und Neigungssensor': { fr: "Alarme avec détection intérieure et capteur d'inclinaison", de: "Alarmanlage mit Innenraumüberwachung", it: "Allarme con sensore interno", en: "Alarm with interior monitoring" },
  'Alarmanlage mitInnenraumüberwachung und Neigungssensor': { fr: "Alarme avec détection intérieure et capteur d'inclinaison", de: "Alarmanlage mit Innenraumüberwachung", it: "Allarme con sensore interno", en: "Alarm with interior monitoring" },
  'Allradantrieb permanent':       { fr: "Transmission intégrale permanente", de: "Permanenter Allradantrieb", it: "Trazione integrale permanente", en: "Permanent all-wheel drive" },
  'Allumage automatique des feux': { fr: "Allumage automatique des feux", de: "Automatisches Fahrlicht", it: "Accensione automatica dei fari", en: "Automatic headlights" },
  'Appliques décoratives en optique': { fr: "Appliques décoratives", de: "Dekoreinlagen in Optik", it: "Inserti decorativi", en: "Decorative trim inserts" },
  'Audi drive select':             { fr: "Audi drive select", de: "Audi drive select", it: "Audi drive select", en: "Audi drive select" },
  'Aussenspiegel in Alu':          { fr: "Rétroviseurs en aluminium", de: "Außenspiegel in Alu", it: "Specchietti in alluminio", en: "Aluminium wing mirrors" },
  'Aussenspiegel rechts und links beheizt,': { fr: "Rétroviseurs chauffants gauche et droite", de: "Beheizbare Außenspiegel", it: "Specchietti riscaldati", en: "Heated wing mirrors" },
  'Aussenspiegel rechts und links beheizt und elektrisch verstellbar, asphärisch gewölbtes Spiegelglas': { fr: "Rétroviseurs chauffants, électriques et asphériques", de: "Beheizbare elektrische Außenspiegel", it: "Specchietti riscaldati elettrici asferici", en: "Heated electric aspherical mirrors" },
  'Baguettes de protection en couleur': { fr: "Baguettes de protection teintées", de: "Farbige Schutzleisten", it: "Modanature di protezione colorate", en: "Colour-matched protection strips" },
  'Beide Make up-Spiegel beleuchtet': { fr: "Miroirs de courtoisie éclairés", de: "Beleuchtete Schminkspiegel", it: "Specchietti di cortesia illuminati", en: "Illuminated vanity mirrors" },
  'Beifahrersitz höhenverstellbar': { fr: "Siège passager réglable en hauteur", de: "Höhenverstellbarer Beifahrersitz", it: "Sedile passeggero regolabile in altezza", en: "Height-adjustable passenger seat" },
  'BMW Individual Dachhimmel Anthrazit': { fr: "Ciel de toit BMW Individual anthracite", de: "BMW Individual Dachhimmel Anthrazit", it: "Cielo del tetto BMW Individual antracite", en: "BMW Individual anthracite headliner" },
  'Boîte à 7 vitesses séquentielle': { fr: "Boîte DSG 7 rapports", de: "7-Gang-Doppelkupplungsgetriebe", it: "Cambio DSG 7 marce", en: "7-speed DSG gearbox" },
  'Befestigungsösen im Laderaum':  { fr: "Crochets d'arrimage dans le coffre", de: "Befestigungsösen im Laderaum", it: "Ganci di fissaggio nel bagagliaio", en: "Cargo securing hooks" },
  'Blinker in Aussenspiegel':      { fr: "Clignotants dans les rétroviseurs", de: "Blinker in Außenspiegel", it: "Frecce negli specchietti", en: "Indicators in wing mirrors" },
  'Climatisation à régulation':    { fr: "Climatisation automatique bi-zone", de: "Klimaautomatik", it: "Climatizzatore automatico bizona", en: "Automatic dual-zone climate control" },
  'Combiné dinstruments avec dotation': { fr: "Combiné d'instruments enrichi", de: "Kombiinstrument mit erweiterter Ausstattung", it: "Strumentazione avanzata", en: "Enhanced instrument cluster" },
  'Combiné d instruments avec dotation élargie': { fr: "Combiné d'instruments enrichi", de: "Kombiinstrument mit erweiterter Ausstattung", it: "Strumentazione avanzata", en: "Enhanced instrument cluster" },
  'ConnectedDrive Pack Professional': { fr: "Pack ConnectedDrive Professional", de: "ConnectedDrive Pack Professional", it: "Pack ConnectedDrive Professional", en: "ConnectedDrive Professional Pack" },
  'Concierge Service':             { fr: "Service Concierge BMW", de: "Concierge Service", it: "Servizio Concierge", en: "Concierge Service" },
  'Direction dynamique':           { fr: "Direction dynamique variable", de: "Dynamische Lenkung", it: "Sterzo dinamico", en: "Dynamic variable steering" },
  'Elektronisches Stabilitäts-Programm (ESP)': { fr: "Contrôle de stabilité ESP", de: "ESP", it: "Controllo di stabilità ESP", en: "Electronic stability control ESP" },
  'Fahrer-Informationssystem mit Farbdisplay': { fr: "Système d'information conducteur avec écran couleur", de: "Fahrerinformationssystem", it: "Sistema informativo conducente", en: "Driver information system with colour display" },
  'Freisprecheinrichtung':         { fr: "Kit mains libres", de: "Freisprecheinrichtung", it: "Vivavoce", en: "Hands-free kit" },
  'Frontscheibe mit Color-Band':   { fr: "Pare-brise avec bandeau teinté", de: "Frontscheibe mit Farbband", it: "Parabrezza con banda colorata", en: "Windscreen with colour band" },
  'Garantie: 2 Jahre ohne Kilometerbegrenzung (ab 1. Inv.)': { fr: "Garantie 2 ans kilométrage illimité", de: "2 Jahre Garantie ohne Kilometerbegrenzung", it: "Garanzia 2 anni chilometri illimitati", en: "2-year unlimited mileage warranty" },
  'Gurtstraffer vorne':            { fr: "Prétensionneurs de ceinture avant", de: "Gurtstraffer vorne", it: "Pretensionatori cinture anteriori", en: "Front seatbelt pretensioners" },
  'Harman/Kardon Surround Sound-System': { fr: "Système audio Harman/Kardon Surround", de: "Harman/Kardon Surround Sound", it: "Sistema audio Harman/Kardon Surround", en: "Harman/Kardon surround sound system" },
  'Harman/Kardon-Soundsystem':     { fr: "Système audio Harman/Kardon", de: "Harman/Kardon Soundsystem", it: "Sistema audio Harman/Kardon", en: "Harman/Kardon sound system" },
  'Höhenverstellbare Gurten vorne': { fr: "Ceintures avant réglables en hauteur", de: "Höhenverstellbare Gurte vorne", it: "Cinture anteriori regolabili in altezza", en: "Height-adjustable front seatbelts" },
  'Innen- und Aussenspiegel automatisch abblendend': { fr: "Rétroviseurs intérieur/extérieur photochromatiques", de: "Automatisch abblendende Spiegel", it: "Specchietti fotocromatici", en: "Auto-dimming interior/exterior mirrors" },
  'Innenraumlicht-Paket':          { fr: "Pack éclairage intérieur", de: "Innenraumlicht-Paket", it: "Kit illuminazione interna", en: "Interior lighting package" },
  'Interieurleisten Carbon':       { fr: "Inserts intérieurs en carbone", de: "Interieurleisten Carbon", it: "Inserti interni in carbonio", en: "Carbon interior trim" },
  'Jantes en alliage léger19J':    { fr: "Jantes en alliage 19 pouces", de: "Leichtmetallfelgen 19 Zoll", it: "Cerchi in lega 19 pollici", en: "19-inch alloy wheels" },
  'Kit mains libres Bluetooth avec': { fr: "Kit mains libres Bluetooth", de: "Bluetooth Freisprecheinrichtung", it: "Kit vivavoce Bluetooth", en: "Bluetooth hands-free kit" },
  'M Roues en alliage léger à rayons en': { fr: "Jantes M en alliage léger", de: "M Leichtmetallräder", it: "Cerchi M in lega leggera", en: "M light-alloy wheels" },
  'Media: Telefonie mit Wireless Charging': { fr: "Téléphonie avec chargement sans fil", de: "Telefonie mit Wireless Charging", it: "Telefonia con ricarica wireless", en: "Phone with wireless charging" },
  'Mèdias: Téléphonie avec Wireless Charging': { fr: "Téléphonie avec chargement sans fil", de: "Telefonie mit Wireless Charging", it: "Telefonia con ricarica wireless", en: "Phone with wireless charging" },
  'Real Time Traffic Information':  { fr: "Informations trafic en temps réel", de: "Echtzeit-Verkehrsinformationen", it: "Informazioni traffico in tempo reale", en: "Real-time traffic information" },
  'Système d alarme antivol, dispositif de': { fr: "Système antivol", de: "Diebstahlalarmanlage", it: "Sistema antifurto", en: "Anti-theft alarm system" },
  'Système de navigation Professional': { fr: "Navigation Professional", de: "Navigationssystem Professional", it: "Navigazione Professional", en: "Professional navigation system" },
  'Wi-Fi Hotspot':                 { fr: "Point d'accès Wi-Fi", de: "WLAN Hotspot", it: "Hotspot Wi-Fi", en: "Wi-Fi hotspot" },
  'Abschliessbare Radschrauben':   { fr: "Boulons de roues antivol", de: "Abschließbare Radschrauben", it: "Bulloni ruota antifurto", en: "Locking wheel bolts" },
  'Airbag: Airbag Beifahrer deaktivierbar': { fr: "Airbag passager désactivable", de: "Abschaltbarer Beifahrerairbag", it: "Airbag passeggero disattivabile", en: "Deactivatable passenger airbag" },
  'Airbag: AirbagBeifahrer deaktivierbar': { fr: "Airbag passager désactivable", de: "Abschaltbarer Beifahrerairbag", it: "Airbag passeggero disattivabile", en: "Deactivatable passenger airbag" },
  'Airbag: Seitenairbag für Fahrer und Beifahrer': { fr: "Airbags latéraux conducteur et passager", de: "Seitenairbags vorne", it: "Airbag laterali anteriori", en: "Front side airbags" },
  'Appel d urgence intelligent':   { fr: "Appel d'urgence intelligent", de: "Intelligenter Notruf", it: "Chiamata di emergenza intelligente", en: "Intelligent emergency call" },
  'Assist: CorneringBrake Control (CBC)': { fr: "Contrôle de freinage en virage (CBC)", de: "Cornering Brake Control", it: "Controllo frenata in curva", en: "Cornering Brake Control" },
  'Assist: Crash-Sensor':          { fr: "Capteur de collision", de: "Crash-Sensor", it: "Sensore di collisione", en: "Crash sensor" },
  'Assist: Park Distance Control arriere': { fr: "Aide au stationnement arrière", de: "Park Distance Control hinten", it: "Assistenza parcheggio posteriore", en: "Rear parking distance control" },
  'Assist: Rückfahrkamera':        { fr: "Caméra de recul", de: "Rückfahrkamera", it: "Telecamera posteriore", en: "Rear-view camera" },
  'Assistant de démarrage':        { fr: "Assistant de démarrage en côte", de: "Anfahrassistent", it: "Assistente alla partenza in salita", en: "Hill start assist" },
  'Filet porte-bagages':           { fr: "Filet de rangement coffre", de: "Gepäcknetz", it: "Rete portabagagli", en: "Luggage net" },
  '12-Volt-Steckdose vorne':       { fr: "Prise 12V à l'avant", de: "12V Steckdose vorne", it: "Presa 12V anteriore", en: "12V front socket" },
  '3-Punkt-Sicherheitsgurte auf allen Plätzen': { fr: "Ceintures 3 points sur toutes les places", de: "3-Punkt-Sicherheitsgurte überall", it: "Cinture a 3 punti su tutti i posti", en: "3-point seatbelts on all seats" },
  'Appuis-tête AR':                { fr: "Appuis-tête arrière", de: "Kopfstützen hinten", it: "Poggiatesta posteriori", en: "Rear headrests" },
  'Appuis-tête arrière':           { fr: "Appuis-tête arrière", de: "Kopfstützen hinten", it: "Poggiatesta posteriori", en: "Rear headrests" },
  'Accès confort':                 { fr: "Accès et démarrage confort sans clé", de: "Komfortzugang", it: "Accesso comfort senza chiave", en: "Comfort access keyless entry" },
  'BMW Individual Dachhimmel Anthrazit': { fr: "Ciel de toit BMW Individual anthracite", de: "BMW Individual Dachhimmel Anthrazit", it: "Cielo del tetto BMW Individual antracite", en: "BMW Individual anthracite headliner" },
  'Baguettes d accent en argent':  { fr: "Inserts décoratifs en argent", de: "Zierleisten in Silber", it: "Inserti decorativi argento", en: "Silver decorative inserts" },
  'Baguettes décoratives du toit dans la couleur de la carrosserie': { fr: "Baguettes de toit couleur carrosserie", de: "Dachreling in Wagenfarbe", it: "Barre tetto nel colore della carrozzeria", en: "Roof rails in body colour" },
  'Befestigungsösen im Laderaum':  { fr: "Crochets d'arrimage dans le coffre", de: "Verzurrösen im Laderaum", it: "Ganci di fissaggio nel bagagliaio", en: "Load securing hooks" },
  'Antiblockiersystem (ABS)':      { fr: "Système antiblocage ABS", de: "ABS", it: "Sistema antibloccaggio ABS", en: "Anti-lock braking system ABS" },
  'Airbag: Airbag Fahrer undBeifahrer': { fr: "Airbags conducteur et passager", de: "Fahrer- und Beifahrerairbag", it: "Airbag guidatore e passeggero", en: "Driver and passenger airbags" },
  'Airbag: Airbag Fahrer und Beifahrer': { fr: "Airbags conducteur et passager", de: "Fahrer- und Beifahrerairbag", it: "Airbag guidatore e passeggero", en: "Driver and passenger airbags" },
  'Assist: Rückfahrkamera':        { fr: "Caméra de recul", de: "Rückfahrkamera", it: "Telecamera posteriore", en: "Rear-view camera" },
  'Baguettes d accent en argent':  { fr: "Inserts décoratifs argent", de: "Silberne Zierleisten", it: "Inserti decorativi argento", en: "Silver decorative trim" },
  'Baguettes décoratives du toit dans la couleur de la carrosserie': { fr: "Baguettes de toit couleur carrosserie", de: "Dachreling in Wagenfarbe", it: "Barre tetto in tinta", en: "Roof rails in body colour" },
  'Combiné d instruments avec dotation élargie': { fr: "Combiné d'instruments enrichi", de: "Kombiinstrument Plus", it: "Strumentazione avanzata", en: "Enhanced instrument cluster" },
  'Freisprecheinrichtung':         { fr: "Kit mains libres", de: "Freisprecheinrichtung", it: "Vivavoce", en: "Hands-free kit" },
  'Gurtstraffer vorne':            { fr: "Prétensionneurs de ceinture avant", de: "Gurtstraffer vorne", it: "Pretensionatori anteriori", en: "Front belt pretensioners" },
  'Höhenverstellbare Gurten vorne': { fr: "Ceintures avant réglables en hauteur", de: "Höhenverstellbare Gurte", it: "Cinture regolabili in altezza", en: "Height-adjustable front belts" },
  'Innenraumlicht-Paket':          { fr: "Pack éclairage intérieur", de: "Innenraumlicht-Paket", it: "Kit illuminazione interna", en: "Interior lighting package" },
  'Jantes en alliage léger19J':    { fr: "Jantes en alliage 19 pouces", de: "Leichtmetallfelgen 19 Zoll", it: "Cerchi in lega 19 pollici", en: "19-inch light alloy wheels" },
  'Frontscheibe mit Color-Band':   { fr: "Pare-brise avec bandeau teinté", de: "Frontscheibe mit Farbband", it: "Parabrezza con banda colorata", en: "Windscreen with tinted band" },
  'Fahrer-Informationssystem mit Farbdisplay': { fr: "Système d'info conducteur écran couleur", de: "Fahrerinformationssystem Farbdisplay", it: "Sistema info conducente display", en: "Colour driver info display" },
  'Garantie: 2 Jahre ohne Kilometerbegrenzung (ab 1. Inv.)': { fr: "Garantie 2 ans kilométrage illimité", de: "2 Jahre Garantie", it: "Garanzia 2 anni km illimitati", en: "2-year unlimited mileage warranty" },

  // ─── AUDI RS SPECIFIC ───────────────────────────────────
  'Cockpit virtuel Audi plus mit zusätzlichem RS-Layout': { fr: "Cockpit virtuel Audi plus avec layout RS", de: "Audi virtual cockpit plus mit RS-Layout", it: "Cockpit virtuale Audi plus con layout RS", en: "Audi virtual cockpit plus with RS layout" },
  'Cockpit virtuel Audi plus':      { fr: "Cockpit virtuel Audi plus", de: "Audi virtual cockpit plus", it: "Cockpit virtuale Audi plus", en: "Audi virtual cockpit plus" },
  'RS-Abgasanlage':                 { fr: "Échappement RS sport", de: "RS-Abgasanlage", it: "Scarico RS sport", en: "RS sport exhaust system" },
  'RS-Performance-Paket':           { fr: "Pack RS Performance", de: "RS-Performance-Paket", it: "Pacchetto RS Performance", en: "RS Performance Package" },
  'Sportfahrwerk':                  { fr: "Châssis sport", de: "Sportfahrwerk", it: "Telaio sportivo", en: "Sport suspension" },
  'Magnetfahrwerk':                 { fr: "Suspension magnétique", de: "Magnetfahrwerk", it: "Sospensioni magnetiche", en: "Magnetic ride suspension" },
  'RS-Sportsitze':                  { fr: "Sièges sport RS", de: "RS-Sportsitze", it: "Sedili sportivi RS", en: "RS sport seats" },
  'RS-Sportlederlenkrad':           { fr: "Volant sport RS en cuir", de: "RS-Sportlederlenkrad", it: "Volante sportivo RS in pelle", en: "RS sport leather steering wheel" },
  'Bang & Olufsen Soundsystem':     { fr: "Système audio Bang & Olufsen", de: "Bang & Olufsen Soundsystem", it: "Sistema audio Bang & Olufsen", en: "Bang & Olufsen sound system" },
  'Matrix LED-Scheinwerfer':        { fr: "Phares Matrix LED", de: "Matrix LED-Scheinwerfer", it: "Fari Matrix LED", en: "Matrix LED headlights" },
  'Quattro Allradantrieb':          { fr: "Transmission intégrale Quattro", de: "Quattro Allradantrieb", it: "Trazione integrale Quattro", en: "Quattro all-wheel drive" },
};

let _currentLangue = 'fr';
function setLangue(l) { _currentLangue = l; }

function traduireOption(opt) {
  if (OPTIONS_DICT[opt] === null) return null;
  if (OPTIONS_DICT[opt]) {
    const val = OPTIONS_DICT[opt][_currentLangue] || OPTIONS_DICT[opt]['fr'];
    return val || null;
  }
  return opt;
}

// ─── RECHERCHE TAVILY ────────────────────────────────────
async function rechercherInfosVehicule(marque, modele, annee, km = '', langue = 'fr', titre = '') {
  try {
    const languesNoms = { fr: 'français', de: 'allemand', it: 'italien', en: 'anglais' };
    const langueNom = languesNoms[langue] || 'français';

    // Description précise du véhicule : le titre de l'annonce contient souvent le moteur (ex : "2.5 TSI quattro")
    const titrePropre = (titre || '').replace(/\*[^*]*\*/g, ' ').replace(/\s{2,}/g, ' ').trim();
    const moteur = (titrePropre.match(/\b\d[.,]\d\s*[A-Za-z-]{0,10}\b/) || [''])[0].trim();
    const vehicule = `${marque} ${modele}${moteur ? ' ' + moteur : ''}${annee ? ' ' + annee : ''}`.replace(/\s{2,}/g, ' ').trim();

    // 2 recherches ciblées fiabilité (FR + EN, les sources anglophones sont souvent plus détaillées).
    // (supprimé : recherche "prix" en double avec rechercherPrixMarcheViaTavily, et recherche "rappels" qui ne
    //  ramenait que des rappels américains — économie de 2 recherches par rapport)
    const queries = [
      `${vehicule} fiabilité problèmes connus moteur boîte électronique`,
      `${vehicule} reliability common problems engine gearbox owners`
    ];
    console.log('Recherche fiabilité pour :', vehicule);

    const results = await Promise.all(queries.map(q =>
      axios.post('https://api.tavily.com/search', {
        api_key: process.env.TAVILY_API_KEY,
        query: q,
        search_depth: 'advanced',
        max_results: 6,
        include_answer: false
      }, { timeout: 15000 }).catch(() => ({ data: { results: [] } }))
    ));

    // Chaque source avec son adresse, pour que l'IA puisse juger de quoi elle parle
    const vues = new Set();
    const sources = [];
    for (const r of results.flatMap(x => x.data.results || [])) {
      if (!r || !r.url || vues.has(r.url)) continue;
      vues.add(r.url);
      const contenu = (r.content || r.snippet || '').replace(/\s+/g, ' ').trim();
      if (contenu.length > 80) sources.push(`SOURCE: ${r.url}\n${contenu.slice(0, 1500)}`);
    }
    const toutLeContenu = sources.join('\n\n').slice(0, 12000);
    console.log(`Sources fiabilité: ${sources.length} (${toutLeContenu.length} caractères)`);

    let problemesListe = [];
    let pointsSolides = [];
    let noteFiabilite = null;
    let justificationFiabilite = '';
    if (toutLeContenu.length > 100) {
      try {
        const gptResp = await axios.post('https://api.openai.com/v1/chat/completions', {
          model: 'gpt-4o',
          // 3 analyses indépendantes des mêmes sources : on garde la note médiane (évite une note "accidentelle")
          temperature: 0.4,
          n: 3,
          max_tokens: 800,
          response_format: { type: 'json_object' },
          messages: [{
            role: 'system',
            content: `Tu es un expert automobile rigoureux. Véhicule analysé : ${vehicule}${titrePropre ? ` (titre de l'annonce : "${titrePropre}")` : ''}.
À partir des sources ci-dessous, identifie :
1. "problemes" : les défauts RÉELLEMENT documentés pour CE véhicule précis — même génération (années de production), même moteur, même boîte. De 0 à 4 maximum.
2. "points_solides" : ce qui est réputé fiable sur CE véhicule (ex : moteur robuste, boîte sans souci connu). De 0 à 3.

Règles strictes :
- Une source qui parle d'une autre génération, d'un autre moteur ou d'un autre modèle (ex : version 4 cylindres, ancienne génération) doit être IGNORÉE.
- Exclure l'usure normale (freins, pneus, embrayage, amortisseurs) sauf si les sources la décrivent comme anormale pour CE modèle.
- Pas de doublon : un même composant = un seul point.
- Si les sources ne documentent aucun problème concret pour CE véhicule, "problemes" = [] — n'invente JAMAIS pour remplir.
- Chaque problème : 1 phrase factuelle (40 à 150 caractères) qui nomme le composant et précise s'il est mineur ou coûteux.
- Aucun code ni numéro (ex : 22V123), aucun "je"/"nous".
- Rédigé en ${langueNom}.
- Attention : la transmission, la boîte, le moteur ou l'électronique changent souvent d'une génération à l'autre. Pour chaque problème, indique dans "concerne" :
  "oui" = la source parle explicitement de cette génération / ces années / ce moteur ;
  "probable" = même moteur ou même boîte, génération non précisée mais composant identique ;
  "incertain" = la source peut concerner une autre génération ou un composant qui a changé.
3. "note_fiabilite" : note de 1 à 10 pour CE véhicule, selon ce barème :
  9-10 très fiable, aucun problème notable documenté ; 7-8 bonne fiabilité, défauts mineurs ou peu coûteux ;
  5-6 problèmes connus et coûteux mais gérables avec un bon entretien ; 3-4 problèmes sérieux et fréquents ; 1-2 très problématique.
  Pèse la GRAVITÉ et la FRÉQUENCE réelles : un défaut rare ou lié à un usage extrême (circuit) compte peu ; un moteur ou une boîte réputés robustes comptent beaucoup.
4. "justification" : 1 phrase (max 160 caractères) qui cite ce qui est solide ET ce qui est fragile.
Réponds avec un objet JSON : {"problemes": [{"texte": "...", "concerne": "oui|probable|incertain"}], "points_solides": ["..."], "note_fiabilite": 7, "justification": "..."}`
          }, {
            role: 'user',
            content: toutLeContenu
          }]
        }, {
          headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
          timeout: 30000
        });

        // Plusieurs analyses : on retient celle dont la note est la médiane
        const lisibles = (gptResp.data.choices || []).map(c => {
          try { return JSON.parse(String(c.message.content || '').replace(/```json|```/g, '').trim()); } catch (e) { return null; }
        }).filter(Boolean);
        if (!lisibles.length) throw new Error('aucune analyse de fiabilité lisible');
        const analyses = lisibles.filter(a => Number(a.note_fiabilite) >= 1 && Number(a.note_fiabilite) <= 10);
        let obj = lisibles[0];
        if (analyses.length) {
          const notes = analyses.map(a => Math.round(Number(a.note_fiabilite))).sort((x, y) => x - y);
          const mediane = notes[Math.floor((notes.length - 1) / 2)];
          obj = analyses.find(a => Math.round(Number(a.note_fiabilite)) === mediane);
          noteFiabilite = mediane;
          justificationFiabilite = String(obj.justification || '').trim();
          console.log(`Fiabilité — notes des ${notes.length} analyses : ${notes.join(', ')} → retenue : ${mediane}`);
        }
        const propre = (arr, n) => (Array.isArray(arr) ? arr : []).filter(p => typeof p === 'string' && p.trim().length > 15).map(p => p.trim()).slice(0, n);
        // On ne garde que les problèmes qui concernent vraiment CE véhicule
        const bruts = Array.isArray(obj.problemes) ? obj.problemes : [];
        const retenus = bruts.filter(p => typeof p === 'string' || (p && p.concerne !== 'incertain'))
                             .map(p => (typeof p === 'string' ? p : p.texte));
        const ecartes = bruts.filter(p => p && typeof p === 'object' && p.concerne === 'incertain').map(p => p.texte);
        if (ecartes.length) console.log('Problèmes écartés (génération incertaine):', ecartes.join(' | '));
        problemesListe = propre(retenus, 4);
        pointsSolides = propre(obj.points_solides, 3);
        console.log(`Fiabilité — problèmes: ${problemesListe.length}, points solides: ${pointsSolides.length}`);
      } catch (e) {
        console.log('GPT synthèse fiabilité erreur:', e.message);
      }
    }

    // Numéros de rappel : désactivés tant que la source est américaine (NHTSA) — non pertinents pour la Suisse.
    // Seront remplacés par la base officielle européenne (KBA / Safety Gate) dans une prochaine étape.
    return {
      prix: '',
      problemesDocumentes: problemesListe,
      pointsSolides,
      nbSources: sources.length,
      noteFiabilite,
      justificationFiabilite,
      moteur,
      numerosRappel: []
    };
  } catch (e) {
    console.log('Tavily erreur (non bloquant):', e.message);
    return { prix: '', problemesDocumentes: [], pointsSolides: [], numerosRappel: [] };
  }
}

// ─── PRIX MARCHÉ RÉEL (Tavily search sémantique) ──────────
// Plus précis que le scraping AutoScout24 : Tavily cible la bonne génération
// en cherchant par année exacte, évitant les confusions 8V/8Y, E46/E92, etc.
// ─── VRAI PRIX DU MARCHÉ : annonces comparables sur AutoScout24 ──────────────
// Lit la page de résultats du même modèle (année ±1), garde les annonces proches en km,
// et calcule la médiane réelle. Renvoie null s'il y a moins de 5 annonces comparables.
const slugAs24 = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const quantile = (arr, q) => {
  const a = [...arr].sort((x, y) => x - y);
  const pos = (a.length - 1) * q, b = Math.floor(pos), r = pos - b;
  return a[b + 1] !== undefined ? a[b] + r * (a[b + 1] - a[b]) : a[b];
};
// Lit la liste officielle des annonces (schema.org "OfferCatalog") de la page de résultats AutoScout24.
// Chaque annonce : nom, lien, description ("Essence, Automatique, 400 PS, 31'000 km") et prix.
function lireCatalogueResultats(html) {
  const annonces = [];
  const vus = new Set();
  const re = /"@type"\s*:\s*"Product"\s*,\s*"name"\s*:\s*"([^"]{2,200})"\s*,\s*"url"\s*:\s*"([^"]+)"([\s\S]{0,1500}?)"price"\s*:\s*"?(\d{3,7})/g;
  for (const m of html.matchAll(re)) {
    const lien = m[2];
    const id = (lien.match(/-(\d{6,})(?:[/?#]|$)/) || [])[1];
    if (!id || vus.has(id)) continue;
    vus.add(id);
    const desc = (m[3].match(/"description"\s*:\s*"([^"]*)"/) || [])[1] || '';
    const kmM = desc.match(/(\d{1,3}(?:['’\u2019.\s]\d{3})+|\d{1,7})\s*km/i);
    const psM = desc.match(/(\d{2,4})\s*(?:PS|ch|CV|hp)\b/i);
    const anM = (m[3].match(/"(?:vehicleModelDate|productionDate|dateVehicleFirstRegistered|modelDate)"\s*:\s*"?(\d{4})/) || [])[1];
    annonces.push({
      titre: reparerCaracteres(m[1]).slice(0, 90),
      prix: parseInt(m[4]),
      km: kmM ? parseInt(kmM[1].replace(/[^\d]/g, '')) : null,
      annee: anM ? parseInt(anM) : null,
      puissance: psM ? parseInt(psM[1]) : null,
      lien: lien.startsWith('http') ? lien : 'https://www.autoscout24.ch' + lien,
      id
    });
  }
  return annonces;
}

async function rechercherComparablesAS24(infos, marque, modele, annee, km) {
  try {
    if (!annee || !km) { console.log('Comparables : année ou km inconnu — ignoré'); return null; }
    let chemin = infos.lienRecherche;
    if (!chemin) {
      const motModele = String(modele || '').split(/\s+/)[0];
      if (!marque || !motModele) return null;
      chemin = `/fr/s/mo-${slugAs24(motModele)}/mk-${slugAs24(marque)}`;
    }
    const urlRecherche = `https://www.autoscout24.ch${chemin.replace(/^\/(de|it|en)\//, '/fr/')}?firstRegistrationYearFrom=${annee - 1}&firstRegistrationYearTo=${annee + 1}`;
    console.log('Comparables — recherche :', urlRecherche);

    const resp = await axios.get('https://api.zenrows.com/v1/', {
      params: { apikey: process.env.ZENROWS_API_KEY, url: urlRecherche, js_render: 'true', premium_proxy: 'true', wait: '6000' },
      timeout: 120000
    });
    let html = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
    html = reparerCaracteres(html);

    // MÉTHODE 1 (fiable, sans IA) : le catalogue schema.org de la page
    // L'année de chaque annonce est déjà garantie par le filtre de la recherche (année ±1).
    const catalogue = lireCatalogueResultats(html).filter(a => a.id !== infos.idAnnonce);
    console.log(`Comparables — catalogue de la page : ${catalogue.length} annonces (${catalogue.filter(a => a.km != null).length} avec km)`);
    let toutes = null;
    if (catalogue.filter(a => a.km != null && a.prix > 1000).length >= 5) {
      toutes = catalogue.filter(a => a.km != null && a.prix > 1000)
        .filter(a => !a.annee || Math.abs(a.annee - annee) <= 1)
        .map(a => ({ ...a, annee: a.annee || null }));
    }

    if (!toutes) {
    // MÉTHODE 2 (secours) : extraction par IA du texte de la page
    // Chaque carte d'annonce = un lien /d/... ; on garde le lien + le texte de la carte
    const cartes = [];
    const vus = new Set();
    for (const m of html.matchAll(/<a[^>]+href=["'](\/(?:fr|de|it|en)\/d\/[^"'?#]+)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const lien = m[1];
      const id = (lien.match(/-(\d{6,})$/) || [])[1];
      if (!id || vus.has(id) || id === infos.idAnnonce) continue;
      const texte = m[2].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
      if (texte.length < 15) continue;
      vus.add(id);
      cartes.push(`${lien} | ${texte.slice(0, 300)}`);
    }
    let matiere = cartes.join('\n');
    // Les détails (km, année) des annonces sont souvent dans les données JSON de la page plutôt que dans le HTML visible :
    // on récupère des extraits autour de chaque "mileage" (format JSON normal ou échappé)
    const extraitsJson = [];
    let dernier = -2000;
    for (const m of html.matchAll(/\\?"mileage\\?"\s*:\s*\d+/g)) {
      if (m.index - dernier < 900) continue;
      dernier = m.index;
      extraitsJson.push(html.substring(Math.max(0, m.index - 700), m.index + 700).replace(/\\"/g, '"').replace(/\s+/g, ' '));
      if (extraitsJson.length >= 25) break;
    }
    console.log(`Comparables — ${extraitsJson.length} blocs de données JSON trouvés`);
    if (cartes.length < 5 && extraitsJson.length >= 5) {
      matiere = extraitsJson.map((e, i) => `ANNONCE ${i + 1}: ${e}`).join('\n');
    } else if (cartes.length < 5) {
      // Repli : texte complet de la page
      matiere = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<svg[\s\S]*?<\/svg>/gi, ' ')
        .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
    }
    matiere = matiere.slice(0, 16000);
    console.log(`Comparables — ${cartes.length} cartes d'annonces trouvées dans la page`);

    const gpt = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 2500,
      response_format: { type: 'json_object' },
      messages: [{
        role: 'system',
        content: `Extrais les annonces de voitures de ce contenu de page de résultats AutoScout24 (texte de cartes, ou extraits de données JSON — un bloc par annonce ; dans le JSON, le kilométrage est souvent "mileage", le prix "price", l'année dans "firstRegistrationDate"/"firstRegistrationYear", et l'identifiant "id"). Pour chaque annonce : "titre", "prix" (CHF, nombre entier), "km" (nombre entier), "annee" (année de 1re immatriculation, 4 chiffres), "lien" (chemin /fr/d/... s'il est donné), "id" (identifiant numérique de l'annonce s'il est donné). Ne recopie QUE ce qui est écrit ; si une valeur manque, mets null. Ignore les publicités et les annonces sans prix. Réponds en JSON : {"annonces": [...]}`
      }, { role: 'user', content: matiere }]
    }, { headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 60000 });

    const obj = JSON.parse(gpt.data.choices[0].message.content);
    toutes = (obj.annonces || []).map(a => ({
      titre: String(a.titre || '').slice(0, 90),
      prix: parseInt(String(a.prix || '').replace(/[^\d]/g, '')) || 0,
      km: parseInt(String(a.km ?? '').replace(/[^\d]/g, '')) || null,
      annee: parseInt(a.annee) || null,
      lien: a.lien && /^\/(fr|de|it|en)\/d\//.test(a.lien) ? 'https://www.autoscout24.ch' + a.lien
          : (a.id && /^\d{6,}$/.test(String(a.id)) ? `https://www.autoscout24.ch/fr/d/${a.id}` : null)
    })).filter(a => a.prix > 1000 && a.km != null && a.annee && Math.abs(a.annee - annee) <= 1)
      .filter(a => !(infos.idAnnonce && a.lien && a.lien.includes(infos.idAnnonce)));
    } // fin méthode 2
    console.log(`Comparables — ${toutes.length} annonces lisibles (année ${annee - 1}–${annee + 1})`);

    // Annonces proches en km (±40 %, au moins ±20'000 km), élargi à ±70 % si trop peu
    const bande = (f) => toutes.filter(a => Math.abs(a.km - km) <= Math.max(20000, km * f));
    let proches = bande(0.4);
    if (proches.length < 5) proches = bande(0.7);
    if (proches.length < 5) { console.log(`Comparables — seulement ${proches.length} proches en km : données insuffisantes`); return null; }

    // Retirer les valeurs aberrantes (séries spéciales, erreurs de saisie)
    const prixListe = proches.map(a => a.prix);
    const q1 = quantile(prixListe, 0.25), q3 = quantile(prixListe, 0.75), iqr = q3 - q1;
    const retenues = proches.filter(a => a.prix >= q1 - 1.5 * iqr && a.prix <= q3 + 1.5 * iqr);
    const p = retenues.map(a => a.prix);
    const arr = (v) => Math.round(v / 100) * 100;
    const resultat = {
      min: arr(quantile(p, 0.2)),
      mediane: arr(quantile(p, 0.5)),
      max: arr(quantile(p, 0.8)),
      confiance: retenues.length >= 8 ? 'haute' : 'moyenne',
      count: retenues.length,
      source: 'as24',
      kmMoyen: Math.round(retenues.reduce((t, a) => t + a.km, 0) / retenues.length / 1000) * 1000,
      comparables: [...retenues].sort((x, y) => (Math.abs((x.annee || annee) - annee) * 30000 + Math.abs(x.km - km)) - (Math.abs((y.annee || annee) - annee) * 30000 + Math.abs(y.km - km))).slice(0, 3)
        .map(c => ({ titre: c.titre, prix: c.prix, km: c.km, annee: c.annee, lien: c.lien }))
    };
    console.log(`Comparables — ${resultat.count} retenues : médiane ${resultat.mediane}, fourchette ${resultat.min}–${resultat.max}, km moyen ${resultat.kmMoyen}`);
    return resultat;
  } catch (e) {
    console.log('Comparables erreur (repli sur estimation web):', e.message);
    return null;
  }
}

async function rechercherPrixMarcheViaTavily(marque, modele, annee, km) {
  try {
    // Construire une query précise ciblant la bonne génération sur le marché suisse
    const anneeRange = `${annee-1} ${annee} ${annee+1}`;
    const kmStr = km > 0 ? `${Math.round(km/10000)*10000}km` : '';
    const queries = [
      // Query principale : prix du bon millésime sur autoscout24 CH
      `${marque} ${modele} ${annee} occasion prix CHF autoscout24.ch suisse`,
      // Query complémentaire : fourchette prix marché suisse
      `${marque} ${modele} ${anneeRange} prix marché occasion suisse CHF`
    ];

    console.log('Tavily prix marché queries:', queries[0]);

    const results = await Promise.all(queries.map(q =>
      axios.post('https://api.tavily.com/search', {
        api_key: process.env.TAVILY_API_KEY,
        query: q,
        search_depth: 'advanced',
        max_results: 8,
        include_answer: true,
        include_raw_content: false
      }, { timeout: 15000 }).catch(e => {
        console.log('Tavily prix query erreur:', e.message);
        return { data: { answer: '', results: [] } };
      })
    ));

    // Collecter tout le texte (answers + snippets)
    const toutTexte = [
      results[0].data?.answer || '',
      results[1].data?.answer || '',
      ...(results[0].data?.results || []).map(r => r.content || r.snippet || ''),
      ...(results[1].data?.results || []).map(r => r.content || r.snippet || ''),
    ].join('\n\n');

    console.log(`Tavily prix: ${toutTexte.length} chars collectés`);
    if (toutTexte.length < 50) {
      console.log('Tavily prix — réponse vide, fallback');
      return null;
    }

    // GPT-4o extrait les prix CHF du texte de manière intelligente
    const gptResp = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o',
      temperature: 0,
      max_tokens: 200,
      messages: [{
        role: 'system',
        content: `Tu es un expert automobile suisse. À partir du texte ci-dessous sur la ${marque} ${modele} de ${annee} (${km > 0 ? km.toLocaleString('fr-CH')+'km' : ''}), extrais la fourchette de prix du marché suisse en CHF pour CE véhicule précis.

Règles :
- Ne considère que les véhicules de ${annee-1} à ${annee+1}
- Ignore les années hors de cette plage
- Tiens compte du kilométrage (${km > 0 ? km.toLocaleString('fr-CH')+'km' : 'inconnu'}) : un véhicule avec kilométrage élevé se vend moins cher que la moyenne du marché
- La fourchette doit être réaliste pour UN véhicule de ${annee} avec ${km > 0 ? 'environ '+Math.round(km/10000)*10000+'km' : 'kilométrage inconnu'}, pas pour l'ensemble du marché toutes déclinaisons confondues
- Le "max" ne doit pas dépasser le prix d'un exemplaire similaire bien entretenu avec kilométrage comparable
- Format STRICT (JSON): {"min": 12000, "mediane": 15000, "max": 18000, "confiance": "haute|moyenne|basse"}
- Si aucun prix fiable pour ${annee}, retourne null`
      }, {
        role: 'user',
        content: `Texte marché ${marque} ${modele} ${annee}:\n\n${toutTexte.slice(0, 4000)}`
      }]
    }, {
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 20000
    });

    const raw = gptResp.data.choices[0].message.content.trim();
    console.log('GPT prix marché réponse:', raw);

    if (raw === 'null' || raw.toLowerCase().includes('null')) {
      console.log('GPT prix marché: aucun prix fiable trouvé');
      return null;
    }

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const prixData = JSON.parse(jsonMatch[0]);
    if (!prixData.mediane || prixData.mediane < 1000) return null;

    console.log(`Prix marché Tavily+GPT: ${prixData.min}–${prixData.mediane}–${prixData.max} CHF (confiance: ${prixData.confiance})`);

    // Si confiance basse, on retourne quand même mais on le note
    return {
      min: Math.round(prixData.min / 500) * 500,
      mediane: Math.round(prixData.mediane / 500) * 500,
      max: Math.round(prixData.max / 500) * 500,
      confiance: prixData.confiance || 'moyenne',
      count: 5 // valeur symbolique pour déclencher la logique "données réelles"
    };

  } catch (e) {
    console.log('rechercherPrixMarcheViaTavily erreur (non bloquant):', e.message);
    return null;
  }
}

// ─── CALCUL MARCHÉ (note prix + prix négocié) — mêmes chiffres pour l'IA et pour le PDF ───
function calculerMarche(prixDemande, pm) {
  const arr = (v, m = 500) => Math.round(v / m) * m;
  if (!pm || !(prixDemande > 0) || !(pm.mediane > 0)) return null;
  const min = arr(pm.min), max = arr(pm.max), mediane = pm.mediane;
  const pos = (prixDemande - min) / Math.max(1, max - min);
  let sp;
  if (prixDemande < min) sp = prixDemande < min * 0.95 ? 10 : 9;
  else if (pos <= 0.33) sp = 8;
  else if (pos <= 0.66) sp = 7;
  else if (pos <= 1) sp = 6;
  else {
    const d = prixDemande / max;
    sp = d <= 1.10 ? 5 : d <= 1.15 ? 4 : d <= 1.20 ? 3 : d <= 1.30 ? 2 : 1;
  }
  // Objectif de négociation réaliste (marges habituelles du marché suisse de l'occasion) :
  // - prix ≤ médiane : petite remise de ~2 %
  // - prix > médiane : viser juste sous la médiane, sans dépasser ~8 % de rabais sur le prix demandé
  let cible = prixDemande <= mediane ? prixDemande * 0.98 : Math.max(mediane * 0.98, prixDemande * 0.92);
  let prixNegocie = arr(cible);
  if (prixNegocie >= prixDemande) prixNegocie = Math.floor(prixDemande * 0.99 / 100) * 100;
  const reduction = 1 - prixNegocie / prixDemande;
  const economie = prixDemande - prixNegocie;
  return {
    min, max, mediane, scorePrix: sp, reduction, prixNegocie,
    ecoMin: economie > 0 ? arr(economie, 100) : 0,
    ecoMax: economie > 0 ? arr(economie, 100) : 0
  };
}

// ─── ANALYSE GPT-4o ─────────────────────────────────────
async function analyserAvecGPT(scrapedData, langue, url) {
  const langues = { fr: 'français', de: 'allemand', it: 'italien', en: 'anglais' };

  // FIX: injecter equipmentData directement dans le prompt
  const equipmentSection = scrapedData.equipmentData
    ? `\n\nDONNÉES STRUCTURÉES EXTRAITES (priorité sur le texte brut) :\n${scrapedData.equipmentData}`
    : `\n\nDONNÉES STRUCTURÉES EXTRAITES : (aucune donnée structurée disponible — extraire les options directement du texte brut de l'annonce)`;

  // ── Données de base de l'annonce : priorité aux données structurées lues dans l'annonce ──
  const infos = scrapedData.infos || {};
  let marque = infos.marque || '';
  let modele = infos.modele || '';
  let annee = parseInt(infos.annee) || 0;
  let km = parseInt(infos.km) || 0;
  let prixRef = parseInt(infos.prix) || 0;
  // Repli : prix et km affichés dans le texte de l'annonce (ex : CHF 48'890.– / 77'000 km)
  if (!prixRef) {
    const pm = (scrapedData.html || '').match(/CHF[&nbsp;\s]*(\d{1,3}(?:['’.\s]\d{3})+)/);
    if (pm) prixRef = parseInt(pm[1].replace(/[^\d]/g, '')) || 0;
  }
  if (!km) {
    const kmM = (scrapedData.html || '').match(/(\d{1,3}(?:['’.\s]\d{3})+|\d{3,7})\s*km/i);
    if (kmM) { const v = parseInt(kmM[1].replace(/[^\d]/g, '')); if (v > 100 && v < 2000000) km = v; }
  }

  // Repli uniquement si l'annonce n'a pas de données structurées : recherche avec limites de mots
  // (évite que "Mini" corresponde à "minimum" ou "Seat" à "seats")
  if (!marque || !modele) {
    const snippet = (scrapedData.html || '').substring(0, 3000);
    for (const m of MARQUES) {
      const re = new RegExp(`(^|[^A-Za-zÀ-ú])${m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[^A-Za-zÀ-ú]|$)`, 'i');
      const found = snippet.match(re);
      if (found) {
        if (!marque) marque = m === 'VW' ? 'Volkswagen' : m;
        if (!modele) {
          const after = snippet.substring(found.index + found[0].length).trim();
          const modelWords = after.match(/^([A-Za-zÀ-ú0-9-]{1,15}(?:\s+[A-Za-zÀ-ú0-9-]{1,15}){0,1})/);
          modele = (modelWords?.[1] || '').replace(/\s+\d+(\.\d+)?$/, '').trim();
        }
        break;
      }
    }
  }
  if (!annee) {
    const anneeMatch = (scrapedData.html || '').substring(0, 3000).match(/\b(20[0-3]\d|19[5-9]\d)\b/);
    annee = anneeMatch ? parseInt(anneeMatch[0]) : 0;
  }
  console.log('VÉHICULE IDENTIFIÉ :', marque, modele, annee || '?', km ? km + ' km' : 'km ?', prixRef ? prixRef + ' CHF' : 'prix ?');

  let tavilyContext = { prix: '', problemesDocumentes: [], numerosRappel: [], prixMarche: null };
  // Clés de mémoire : moteur lu dans le titre de l'annonce, tranche de 20'000 km pour le prix
  const titrePropreCle = (infos.titre || '').replace(/\*[^*]*\*/g, ' ');
  const moteurCle = (titrePropreCle.match(/\b\d[.,]\d\s*[A-Za-z-]{0,10}\b/) || [''])[0];
  const cleFiab = cleNorm(marque, modele, moteurCle, annee, langue);
  const cleMarche = cleNorm(marque, modele, annee, Math.round(km / 20000));
  let fiabMemo = null;
  try {
    if (marque && modele) {
      fiabMemo = cacheLire('fiabilite', cleFiab);
      const marcheMemo = cacheLire('marche', cleMarche);
      if (fiabMemo) console.log('CACHE fiabilité utilisé :', cleFiab, `(note ${fiabMemo.score || '?'})`);
      if (marcheMemo) console.log('CACHE prix marché utilisé :', cleMarche);
      const [tavilyResult, prixMarche] = await Promise.all([
        fiabMemo ? Promise.resolve(fiabMemo.recherche) : rechercherInfosVehicule(marque, modele, annee, km, langue, infos.titre || ''),
        marcheMemo !== null ? Promise.resolve(marcheMemo)
          : rechercherComparablesAS24(infos, marque, modele, annee, km).then(r => r || rechercherPrixMarcheViaTavily(marque, modele, annee, km))
      ]);
      tavilyContext = { ...tavilyResult, prixMarche };
      if (!marcheMemo && prixMarche) cacheEcrire('marche', cleMarche, prixMarche);
      if (prixMarche) console.log('Prix marché Tavily:', prixMarche);
    } else {
      console.log('Recherche web ignorée — marque/modèle non identifiés');
    }
  } catch(e) {
    console.log('Recherche web erreur (non bloquant):', e.message);
  }

  const tavilyPrix = tavilyContext.prix || '';
  const tavilyProblemes = Array.isArray(tavilyContext.problemesDocumentes) ? tavilyContext.problemesDocumentes : [];
  const tavilyRappels = tavilyContext.numerosRappel || [];

  // Données marché exploitables seulement si la confiance n'est pas basse
  const prixMarcheCtx = (tavilyContext.prixMarche && tavilyContext.prixMarche.confiance !== 'basse') ? tavilyContext.prixMarche : null;

  const pointsSolides = Array.isArray(tavilyContext.pointsSolides) ? tavilyContext.pointsSolides : [];
  const pointsSolidesSynth = pointsSolides.length > 0
    ? `\nPOINTS RÉPUTÉS SOLIDES SUR CE VÉHICULE (sources réelles) :\n${pointsSolides.map((p,i) => `${i+1}. ${p}`).join('\n')}\n`
    : '';

  // ── Free service : calcul précis de ce qu'il reste (10 ans / 100 000 km) ──
  const anneeCourante = new Date().getFullYear();
  const marquesFreeService = ['bmw', 'audi', 'mercedes', 'mercedes-benz', 'volvo'];
  let contexteFreeService = '';
  let fsAnsRestants = null; // null = pas de free service connu ; 0 = terminé ; sinon années restantes
  if (marque && marquesFreeService.includes(marque.toLowerCase()) && annee && km) {
    const ageAns = Math.max(0.5, anneeCourante - annee + 0.5);
    const kmParAn = Math.round(km / ageAns / 1000) * 1000;
    const kmRestants = 100000 - km;
    const ansRestantsAge = annee + 10 - anneeCourante;
    if (kmRestants <= 0 || ansRestantsAge <= 0) {
      fsAnsRestants = 0;
      contexteFreeService = `\nFREE SERVICE : TERMINÉ (${km.toLocaleString('de-CH')} km, mise en circulation ${annee}). Compter l'entretien complet sur les 3 ans.`;
    } else {
      const ansRestantsKm = kmParAn > 0 ? kmRestants / kmParAn : 99;
      const ansRestants = Math.min(ansRestantsAge, ansRestantsKm);
      fsAnsRestants = ansRestants;
      contexteFreeService = `\nFREE SERVICE (si importation officielle) : encore ~${kmRestants.toLocaleString('de-CH')} km ou ${ansRestantsAge} an(s). Au rythme actuel (~${kmParAn.toLocaleString('de-CH')} km/an), il se termine dans environ ${ansRestants < 1 ? 'moins d\'un an' : ansRestants.toFixed(1).replace('.0', '') + ' an(s)'}. ` +
        (ansRestants < 3 ? `cout_total_3ans DOIT donc inclure l'entretien complet (hors free service) pour les ~${(3 - ansRestants).toFixed(1).replace('.0', '')} dernière(s) année(s) — ce n'est PAS 3 × l'année 1.` : `Les 3 prochaines années restent sous free service.`);
    }
  }

  const fiabRef = (fiabMemo && fiabMemo.score) ? fiabMemo
    : (tavilyContext.noteFiabilite ? { score: tavilyContext.noteFiabilite, justification: tavilyContext.justificationFiabilite || '' } : null);
  const fiabiliteImposee = fiabRef && fiabRef.score
    ? `\nNOTE DE FIABILITÉ DÉJÀ ÉTABLIE POUR CE MODÈLE (pour que tous les rapports soient cohérents) : score_fiabilite = ${fiabRef.score}/10. Utilise EXACTEMENT cette note (sauf red flag propre à CETTE annonce, ex : culasse, accident). Justification de référence : "${fiabRef.justification || ''}"\n`
    : '';
  const tavilyProblemesSynth = tavilyProblemes.length > 0
    ? `\nPROBLÈMES DOCUMENTÉS TROUVÉS DANS DES SOURCES RÉELLES (base principale pour noter la fiabilité) :\n${tavilyProblemes.map((p,i) => `${i+1}. ${p}`).join('\n')}\n`
    : `\nAUCUN PROBLÈME DOCUMENTÉ TROUVÉ DANS LES SOURCES pour ce modèle. Ne pénalise pas la fiabilité sans raison concrète ; si tu connais un défaut réel et largement documenté de CE modèle/génération/moteur, tu peux en tenir compte dans la justification.\n`;

  const marcheAvant = calculerMarche(prixRef, prixMarcheCtx);
  const contexteNegociation = marcheAvant
    ? `\nCHIFFRES CALCULÉS PAR LE SYSTÈME (à utiliser tels quels, ne pas en inventer d'autres) : score_prix = ${marcheAvant.scorePrix}/10 ; prix négocié suggéré = ${marcheAvant.prixNegocie.toLocaleString('de-CH')} CHF ; économie possible ≈ ${marcheAvant.ecoMin.toLocaleString('de-CH')} CHF. Dans conseil_achat, si tu donnes un objectif de négociation, cite EXACTEMENT ${marcheAvant.prixNegocie.toLocaleString('de-CH')} CHF. Ne cite aucun montant d'entretien (il est calculé ailleurs).`
    : `\nDans conseil_achat, ne cite aucun prix de négociation chiffré ni montant d'entretien (pas de données marché fiables).`;
  const contexteComparables = (prixMarcheCtx && prixMarcheCtx.source === 'as24')
    ? `\nANNONCES COMPARABLES RÉELLES (AutoScout24, aujourd'hui) : ${prixMarcheCtx.count} annonces de ${annee - 1} à ${annee + 1} avec un kilométrage proche ; kilométrage moyen ${prixMarcheCtx.kmMoyen.toLocaleString('de-CH')} km (cette voiture : ${km ? km.toLocaleString('de-CH') : '?'} km). Exemples : ${prixMarcheCtx.comparables.map(c => `${c.annee ? c.annee + ', ' : ''}${c.km.toLocaleString('de-CH')} km, ${c.prix.toLocaleString('de-CH')} CHF`).join(' ; ')}. Dans conseil_achat, utilise ces faits comme ARGUMENTS DE NÉGOCIATION concrets (écart à la médiane, kilométrage par rapport à la moyenne).`
    : '';
  const contexteMarche = prixMarcheCtx
    ? `\nDONNÉE MARCHÉ SUISSE (${prixMarcheCtx.source === 'as24' ? `médiane de ${prixMarcheCtx.count} annonces réelles` : 'estimation à partir de sources web'}) : pour ${marque} ${modele} ${annee || ''}, médiane ${prixMarcheCtx.mediane.toLocaleString('de-CH')} CHF, fourchette ${prixMarcheCtx.min.toLocaleString('fr-CH')} – ${prixMarcheCtx.max.toLocaleString('fr-CH')} CHF. Prix demandé dans l'annonce : ${prixRef ? prixRef.toLocaleString('fr-CH') + ' CHF' : 'voir données structurées'}.`
    : `\nAUCUNE DONNÉE MARCHÉ FIABLE TROUVÉE. N'invente pas de fourchette : mets fourchette_marche_min et fourchette_marche_max à 0. Pour score_prix, donne ton estimation et indique clairement dans justification_prix qu'elle est faite sans annonces comparables.`;

  const tavilySection = `\n\nDONNÉES WEB SUR CE VÉHICULE :
${tavilyPrix ? 'Résumé prix trouvé : ' + tavilyPrix + '\n' : ''}${fiabiliteImposee}${tavilyProblemesSynth}${pointsSolidesSynth}${contexteMarche}${contexteComparables}${contexteNegociation}${contexteFreeService}
Pour "problemes_connus_modele" : retourne OBLIGATOIREMENT un tableau VIDE [] — ce champ est rempli par un autre système.\n`;

  // Nettoyer le contenu pour éviter les faux refus GPT (mots techniques mal interprétés)
  const htmlNettoye = (scrapedData.html || '')
    .replace(/\*[^*]*abgass[^*]*\*/gi, '')
    .replace(/\*[^*]*exhaust[^*]*\*/gi, '')
    .replace(/\*[^*]*auspuff[^*]*\*/gi, '')
    .replace(/abgassanlage/gi, 'système d\'échappement')
    .replace(/auspuffanlage/gi, 'système d\'échappement')
    .replace(/\*\s*RS\s+[^*]+\*/gi, '')
    .replace(/tuning|chiptuning|stage\s*[123]/gi, 'préparation sportive');

  const prompt = `LANGUE OBLIGATOIRE : ${langues[langue] || 'français'}
IMPORTANT : Tu dois rédiger ABSOLUMENT TOUT le rapport en ${langues[langue] || 'français'}. Chaque mot, chaque phrase, chaque champ JSON doit être en ${langues[langue] || 'français'}. PAS DE MÉLANGE DE LANGUES.

Tu es un expert en analyse de véhicules d'occasion sur le marché suisse.

Voici le contenu de l'annonce automobile :
URL: ${url}
Contenu: ${htmlNettoye}${equipmentSection}${tavilySection}

ÉTAPE 1 - Extrais ces données EXACTES depuis le contenu :
- Prix exact en CHF (nombre entier) : utilise "PRIX DEMANDÉ" des données structurées si disponible
- Kilométrage exact (nombre entier) : utilise "KILOMÉTRAGE" des données structurées si disponible — c'est la source la plus fiable
- Année exacte : utilise "ANNÉE" des données structurées si disponible
- Marque et modèle exacts
- Carburant (Essence / Diesel / Électrique / Hybride)
- Boîte de vitesses
- Puissance en PS uniquement (ex: "306 PS")
- CO2 en g/km : utilise la valeur de la section "DONNÉES STRUCTURÉES" si disponible (nombre entier, sinon null)
- Couleur exacte — cherche ACTIVEMENT dans tout le contenu : champ "COULEUR" des données structurées, puis dans le texte "Extérieure [couleur]", "Couleur extérieure", "Farbe", ou toute mention de couleur dans le titre/description/caractéristiques. Exemples valides : "Noir Métallisé", "Blanc Nacré", "Gris Nardo", "Rouge Misano". NE MET "Non communiquée" QUE si aucune couleur n'est mentionnée nulle part dans la page.
- Transmission (2 roues motrices / 4 roues motrices)
- Description complète du vendeur : utilise en priorité le champ "DESCRIPTION_VENDEUR" de la section "DONNÉES STRUCTURÉES" ci-dessus s'il est présent. Sinon, extraire le texte descriptif du véhicule rédigé par le vendeur depuis le contenu HTML (état, historique, options, rappels, numéros de série, raison de vente). Exclure uniquement : menus de navigation du site, avis Google des clients, horaires d'ouverture du garage. Si vraiment aucune description vendeur n'est trouvée ni dans les données structurées ni dans le contenu, mets "Non communiquée".
- TOUTES les options et équipements listés — utilise la liste de la section "DONNÉES STRUCTURÉES" ci-dessus en priorité (elle est complète). Si la section "DONNÉES STRUCTURÉES" indique "aucune donnée structurée disponible", extraire les options depuis le texte brut de l'annonce (description, caractéristiques, titre). Supprimer les doublons, traduire tout en ${langues[langue] || 'français'}, supprimer les mentions "Détails consultez la liste de prix" et "Details siehe Preisliste". Si l'annonce ne liste aucune option, retourne [] — n'invente jamais d'équipements.

ÉTAPE 2 - Analyse approfondie :

━━━ PRINCIPE GÉNÉRAL — TOUT DOIT ÊTRE RÉEL ET JUSTIFIÉ ━━━
Chaque note doit être méritée et expliquée par des faits concrets (données de l'annonce, sources web fournies, faits techniques largement documentés sur CE modèle/génération/moteur). N'invente jamais un chiffre, un défaut ou une option. Si une information manque, dis-le au lieu de la deviner.
Les trois notes sont INDÉPENDANTES : un prix trop élevé fait baisser score_prix, PAS score_fiabilite. Une voiture fiable vendue trop cher reste une voiture fiable.

━━━ PRIX ━━━
Utilise les DONNÉES MARCHÉ ci-dessus si elles existent (le serveur recalculera score_prix à partir de ces chiffres).
Si aucune donnée marché fiable : fourchette_marche_min = 0, fourchette_marche_max = 0, et score_prix = ton estimation prudente, avec une justification_prix qui précise qu'il n'y a pas d'annonces comparables.
Barème score_prix (position du prix demandé dans la fourchette) : sous le min → 9-10 ; tiers inférieur → 8 ; milieu → 7 ; tiers supérieur → 6 ; jusqu'à +10 % au-dessus du max → 5 ; +10 à +20 % → 3-4 ; plus de +20 % → 1-2.
Cohérence : si le prix est sous la médiane, ne dis jamais « prix au-dessus du marché ».

━━━ FIABILITÉ ━━━
Note la fiabilité de CE modèle, dans SA génération et avec SA motorisation, d'après les PROBLÈMES DOCUMENTÉS ci-dessus et les faits largement reconnus. Barème :
- 9-10 : très fiable, aucun problème notable documenté
- 7-8 : bonne fiabilité, quelques défauts mineurs ou peu coûteux (ex : petit souci électronique connu mais moteur et boîte solides → 8)
- 5-6 : problèmes connus et coûteux, mais gérables avec un bon entretien
- 3-4 : problèmes sérieux et coûteux fréquents sur ce modèle
- 1-2 : très problématique, risque financier élevé même bien entretenu
Le prix n'entre JAMAIS dans cette note. justification_fiabilite doit citer les points concrets (ce qui est solide ET ce qui est fragile).

━━━ ENTRETIEN & COÛTS ━━━
Estime pour CE modèle précis, en CHF par an, prix des garages suisses (entretien courant : vidange, filtres, révision, liquides, freins, pneus — PAS les réparations imprévues) :
- cout_annuel_complet : coût annuel SANS free service (tout à la charge du propriétaire)
- cout_annuel_couvert : coût annuel SOUS free service (seulement ce qui n'est pas couvert : pneus, plaquettes, disques, liquides). Pour une marque sans free service, mets la même valeur que cout_annuel_complet.
Le serveur calcule lui-même cout_entretien_annee1, cout_total_3ans et score_entretien à partir de ces deux valeurs et de la durée de free service restante (mets 0 à ces trois champs).
FREE SERVICE (BMW, Audi, Mercedes, Volvo) : 10 ans OU 100 000 km depuis la 1re mise en circulation. Utilise le calcul FREE SERVICE fourni plus haut s'il existe. Sous free service, ne compter que ce qui n'est pas couvert (pneus, plaquettes, disques, liquides). Si l'annonce mentionne une importation parallèle/directe, ne suppose PAS le free service et signale-le.
Pneus et freins : compte leur coût RÉEL pour CE véhicule (une sportive puissante use pneus et freins bien plus vite qu'une citadine, et ses pièces coûtent plus cher).
Ordres de grandeur de référence (à ADAPTER au modèle réel, pas à recopier) :
- Hors free service : citadine ~500 CHF/an, berline/break ~800, SUV ~1000, sportive premium ~1200, hypersportive ~2000
- Sous free service : citadine ~250 CHF/an, berline/SUV ~400, sportive premium ~700, hypersportive ~1200
justification_entretien doit dire en une phrase sur quoi repose l'estimation (free service ou non, type de moteur, pneus, freins…).

━━━ QUESTIONS VENDEUR ━━━
Adapter aux problèmes réels documentés de CE modèle. NE PAS poser des questions de circuit/launch control sur une voiture familiale ou quasi neuve (<3 ans, <30 000 km). Exemples d'adaptation :
- Voiture récente <3 ans ou <30 000 km → carnet à jour, garantie, incidents depuis achat
- Diesel familial → DPF, AdBlue, entretien concessionnaire
- Sportive avec risque documenté spécifique → question ciblée sur ce risque exact
- Sportive à usage piste connu → usage circuit, consommation huile

━━━ CHECKLIST VISITE ━━━
Adapter au modèle et à ses risques réels. Pour les modèles à risque moteur documenté : compression, consommation huile, traces d'huile. Pour les sportives : freins, pneus, boîte. Pour les diesel : DPF, EGR, turbo.

━━━ VERDICT ━━━
- ACHETER : aucun red flag ET [ (fiabilité ≥ 8 ET prix ≤ médiane) OU (fiabilité ≥ 7 ET prix ≥ 3 % sous la médiane) OU (fiabilité ≥ 6 ET prix ≥ 5 % sous la médiane) ]
- Un prix simplement égal à la médiane est un prix « correct », pas une bonne affaire.
- NÉGOCIER : prix au-dessus de la médiane, OU points importants à vérifier, OU fiabilité moyenne
- ÉVITER : red flag grave (ex : culasse, accident lourd) avec fiabilité faible, OU fiabilité ≤ 3, OU prix > 15 % au-dessus du max
(Le serveur vérifiera la cohérence de ce verdict avec les notes.)

━━━ RÈGLES TRANSVERSALES ━━━
- CULASSE : si "Zylinderkopf", "culasse" mentionné dans l'annonce → red_flag obligatoire, baisser score_fiabilite de 2 points minimum
- ACCIDENT : si mentionné → red flag, baisser score_fiabilite de 1-2 points selon gravité
- KILOMÉTRAGE : NE JAMAIS mentionner comme point négatif
- SPORTIVES (RS, AMG, M, S, R) : ne pas mentionner la consommation comme point négatif
- BOÎTE : "Manuelle robotisée" = "Automatique (DCT)" pour Mercedes AMG
- DESCRIPTION VENDEUR : traduire INTÉGRALEMENT en ${langues[langue] || 'français'} — "Zylinderkopf" = "culasse", jamais "cylindre de tête"
- Ne jamais inventer des points négatifs absents de l'annonce
- score_global = mettre 0 (calculé automatiquement par le système)
- taxe_cantonale_ge = mettre 0 (calculé automatiquement par le système)
- score_prix, score_fiabilite, score_entretien : OBLIGATOIRE entre 1 et 10, JAMAIS 0
- justification_prix, justification_fiabilite, justification_entretien : OBLIGATOIRES, 1 phrase concrète chacune (max 160 caractères), en ${langues[langue] || 'français'}
- options : inclure TOUTES les options de la liste DONNÉES STRUCTURÉES sans en supprimer, sans tronquer. Si DONNÉES STRUCTURÉES est vide, extraire depuis le texte brut. Si l'annonce n'en mentionne aucune, retourner [].
- Champs de base (carburant, boîte, couleur, transmission…) : si l'information n'est pas dans l'annonce, mettre "Non communiquée" (traduit). Ne jamais deviner.

QUANTITÉS STRICTES — NE PAS DÉPASSER :
- points_positifs : de 1 à 3 éléments réels — OBLIGATOIREMENT en ${langues[langue] || 'français'}
- points_negatifs : de 0 à 3 éléments RÉELS (n'en invente jamais pour atteindre 3) — OBLIGATOIREMENT en ${langues[langue] || 'français'} (JAMAIS kilométrage, JAMAIS consommation pour sportives, JAMAIS "couleur non communiquée" ou tout point lié à un manque d'information dans l'annonce). Chaque point doit être PRÉCIS et CHIFFRÉ si possible, et concerner CE véhicule ou CE modèle. Si le véhicule est encore sous free service (voir calcul FREE SERVICE fourni), NE PAS mentionner les coûts d'entretien comme point négatif — mentionne plutôt d'autres points concrets liés au modèle ou à l'annonce.
- checklist_visite : exactement 4 éléments
- questions_vendeur : exactement 3 questions
- problemes_connus_modele : retourne TOUJOURS un tableau VIDE []. Ce champ est géré par un autre système — tu ne dois JAMAIS le remplir.
- conseil_achat : 3-5 phrases de conseil d'achat PERSONNALISÉ et DÉTAILLÉ pour CE véhicule spécifique. Obligatoirement inclure : (1) positionnement du prix par rapport au marché suisse avec chiffres concrets, (2) le coût total de possession sur 3 ans (achat + entretien estimé), (3) les 1-2 points de vigilance prioritaires liés aux problèmes connus de CE modèle précis, (4) une recommandation claire sur quoi négocier ou vérifier en priorité. Être précis, concret, utile — pas générique. Exemple de niveau attendu : "L'Audi RS3 8Y en châssis 2023 se positionne dans le segment supérieur des sportives compactes. Avec 77 000 km, ce véhicule est encore sous free service Audi jusqu'en 2033, ce qui représente une économie réelle sur l'entretien. Le prix demandé de 48 890 CHF est légèrement au-dessus de la fourchette marché actuelle (45 000–53 000 CHF) pour ce kilométrage — une négociation de 1 500 à 3 000 CHF est réaliste. Vérifiez en priorité l'état de la boîte S-tronic (point faible documenté de la RS3 8Y) et exigez l'historique d'entretien complet chez Audi." IMPORTANT : mentionner une Phase 2 ou génération suivante UNIQUEMENT si toutes ces conditions sont réunies : (1) le véhicule a plus de 4 ans, (2) une Phase 2 ou génération suivante EXISTE réellement et est disponible sur le marché, (3) cette génération corrige des problèmes documentés de la Phase 1. NE PAS mentionner de Phase 2 si le modèle est récent (2022+).

ÉTAPE 3 - Génère le rapport. Rappel : TOUT doit être en ${langues[langue] || 'français'}.

RÈGLES JSON :
1. JSON valide uniquement, rien d'autre
2. verdict = "ACHETER", "NÉGOCIER" ou "ÉVITER"
3. Guillemets doubles uniquement
4. score_global = mettre 0 (recalculé côté serveur)
5. taxe_cantonale_ge = 0

{
  "marque": "",
  "modele": "",
  "annee": "",
  "kilometrage": "",
  "prix": "",
  "carburant": "",
  "boite": "",
  "puissance": "",
  "co2": null,
  "couleur": "",
  "transmission": "",
  "options": [],
  "description_vendeur": "",
  "score_prix": 0,
  "score_fiabilite": 0,
  "score_entretien": 0,
  "cout_annuel_complet": 0,
  "cout_annuel_couvert": 0,
  "justification_prix": "",
  "justification_fiabilite": "",
  "justification_entretien": "",
  "score_global": 0,
  "verdict": "NÉGOCIER",
  "economie_potentielle_min": 0,
  "economie_potentielle_max": 0,
  "prix_negocie_suggere": 0,
  // NE PAS REMPLIR — calculé automatiquement par le serveur
  "fourchette_marche_min": 0,
  "fourchette_marche_max": 0,
  "points_positifs": [],
  "points_negatifs": [],
  "red_flags": [],
  "problemes_connus_modele": [],
  "checklist_visite": [],
  "questions_vendeur": [],
  "conseil_achat": "",
  "cout_entretien_annee1": 0,
  "cout_total_3ans": 0,
  "taxe_cantonale_ge": 0,
  "resume_verdict": ""
}
IMPORTANT pour resume_verdict : écrire une phrase courte de synthèse (ex: "Ce véhicule présente un bon rapport qualité/prix mais nécessite une vérification de la chaîne de distribution.") — NE PAS répéter le mot ACHETER/NÉGOCIER/ÉVITER dans ce champ.`;

  // ── APPEL GPT-4o en mode JSON (élimine presque tous les JSON invalides) ──
  const systemMsg = 'Tu es un expert en analyse de véhicules d\'occasion sur le marché suisse. Tu analyses des annonces automobiles et génères des rapports JSON structurés. Tu réponds TOUJOURS avec un objet JSON valide, sans aucun texte autour. Tu n\'inventes jamais de données.';
  const appelerGPT = async (temperature) => {
    const r = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: prompt }
      ],
      temperature,
      max_tokens: 8000,
      response_format: { type: 'json_object' }
    }, {
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 120000
    });
    return { content: r.data.choices[0].message.content || '', finish: r.data.choices[0].finish_reason };
  };
  const essayerParse = (txt) => {
    let clean = (txt || '').replace(/```json|```/g, '').trim();
    try { return JSON.parse(clean); } catch (e) {}
    clean = clean.replace(/,(\s*[}\]])/g, '$1');
    try { return JSON.parse(clean); } catch (e) {}
    const m = clean.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
    return null;
  };
  const scoreValide = (x) => Number.isFinite(Number(x)) && Number(x) >= 1 && Number(x) <= 10;

  let parsed = null;
  for (let tentative = 1; tentative <= 2 && !parsed; tentative++) {
    const { content, finish } = await appelerGPT(tentative === 1 ? 0 : 0.2);
    console.log(`GPT RESPONSE tentative ${tentative} (finish_reason: ${finish}):`, content.substring(0, 300));
    const p = essayerParse(content);
    if (p && scoreValide(p.score_prix) && scoreValide(p.score_fiabilite)) parsed = p;
    else console.log(`Réponse GPT inutilisable (tentative ${tentative})`);
  }
  // Règle : jamais de rapport avec des valeurs inventées. Si l'analyse échoue, on s'arrête
  // (le webhook envoie alors une alerte pour relancer ou rembourser le client).
  if (!parsed) throw new Error('Analyse IA invalide après 2 tentatives — aucun rapport envoyé');

  const textesNC = { fr: 'Non communiquée', de: 'Nicht angegeben', it: 'Non indicato', en: 'Not specified' };
  const NC = textesNC[langue] || textesNC.fr;
  const arrondir = (val, multiple = 500) => Math.round(val / multiple) * multiple;

  // ── Les données lues dans l'annonce priment sur ce que GPT a compris ──
  if (infos.marque) parsed.marque = infos.marque;
  if (!parsed.modele && modele) parsed.modele = modele;
  if (infos.annee) parsed.annee = String(infos.annee);
  // Format suisse 48'890 (la police du PDF n'affiche pas l'espace fine du format français)
  if (km) parsed.kilometrage = km.toLocaleString('de-CH');
  if (prixRef) parsed.prix = prixRef.toLocaleString('de-CH');
  if (infos.puissance) parsed.puissance = infos.puissance;
  const co2Final = scrapedData.co2 || infos.co2 || parsed.co2 || null;
  parsed.co2 = co2Final;
  ['carburant', 'boite', 'transmission', 'couleur', 'puissance'].forEach(k => {
    if (!parsed[k] || String(parsed[k]).trim() === '') parsed[k] = NC;
  });
  if (!parsed.description_vendeur) parsed.description_vendeur = NC;

  // ── NOTES ──
  parsed.score_prix = Math.round(Number(parsed.score_prix));
  parsed.score_fiabilite = Math.round(Number(parsed.score_fiabilite));
  // Même modèle → même note de fiabilité (les red flags propres à l'annonce s'appliquent ensuite)
  if (marque && modele) {
    if (fiabRef && fiabRef.score) {
      parsed.score_fiabilite = fiabRef.score;
      if (fiabRef.justification) parsed.justification_fiabilite = fiabRef.justification;
    }
    if (!fiabMemo && tavilyProblemes.length + (tavilyContext.pointsSolides || []).length > 0) {
      cacheEcrire('fiabilite', cleFiab, {
        score: parsed.score_fiabilite,
        justification: parsed.justification_fiabilite || '',
        recherche: { prix: '', problemesDocumentes: tavilyProblemes, pointsSolides: tavilyContext.pointsSolides || [], nbSources: tavilyContext.nbSources || 0, numerosRappel: [] }
      });
      console.log('CACHE fiabilité enregistré :', cleFiab, `(note ${parsed.score_fiabilite})`);
    }
  }
  parsed.nb_sources_fiabilite = tavilyContext.nbSources || 0;
  parsed.marche_confiance = prixMarcheCtx ? (prixMarcheCtx.confiance || 'moyenne') : null;
  parsed.marche_source = prixMarcheCtx ? (prixMarcheCtx.source || 'web') : null;
  parsed.marche_nb_annonces = prixMarcheCtx && prixMarcheCtx.source === 'as24' ? prixMarcheCtx.count : 0;
  parsed.comparables = prixMarcheCtx && prixMarcheCtx.source === 'as24' ? (prixMarcheCtx.comparables || []) : [];

  // Entretien : coûts calculés par le serveur à partir des deux estimations annuelles de l'IA
  // et de la durée de free service restante (même barème pour toutes les voitures).
  const scoreEntretienDepuisCout = (c) =>
    c <= 350 ? 9 : c <= 600 ? 8 : c <= 900 ? 7 : c <= 1100 ? 6 : c <= 1600 ? 5 : c <= 2200 ? 4 : c <= 3000 ? 3 : 2;
  const complet = parseInt(parsed.cout_annuel_complet) || parseInt(parsed.cout_entretien_annee1) || 0;
  const couvert = parseInt(parsed.cout_annuel_couvert) || complet;
  if (complet > 0) {
    const fs = fsAnsRestants == null ? 0 : Math.max(0, fsAnsRestants);
    const an1 = fs >= 1 ? couvert : couvert * fs + complet * (1 - fs);
    const total3 = couvert * Math.min(3, fs) + complet * Math.max(0, 3 - fs);
    parsed.cout_entretien_annee1 = Math.round(an1 / 50) * 50;
    parsed.cout_total_3ans = Math.round(total3 / 50) * 50;
    parsed.score_entretien = scoreEntretienDepuisCout(total3 / 3);
    console.log(`ENTRETIEN: complet ${complet}/an, couvert ${couvert}/an, free service restant ${fs.toFixed(1)} an(s) → an 1 ${parsed.cout_entretien_annee1}, 3 ans ${parsed.cout_total_3ans}, note ${parsed.score_entretien}`);
  } else if (scoreValide(parsed.score_entretien)) {
    parsed.score_entretien = Math.round(Number(parsed.score_entretien));
  } else {
    throw new Error('Coût d\'entretien absent de l\'analyse — aucun rapport envoyé');
  }

  // Culasse remplacée → fiabilité plafonnée à 5 (fait signalé dans l'annonce)
  const culasseDetectee = (parsed.red_flags || []).some(r => /culasse|zylinderkopf|testata|cylinder head/i.test(r)) ||
    (parsed.points_negatifs || []).some(p => /culasse|zylinderkopf|testata|cylinder head/i.test(p));
  if (culasseDetectee && parsed.score_fiabilite > 5) parsed.score_fiabilite = 5;

  // ── PRIX & MARCHÉ : uniquement avec des données réelles (même calcul que celui donné à l'IA) ──
  const prixDemande = prixRef || parseInt(String(parsed.prix || '').replace(/[^\d]/g, '')) || 0;
  const marche = calculerMarche(prixDemande, prixMarcheCtx);
  parsed.prix_negocie_suggere = 0;
  parsed.economie_potentielle_min = 0;
  parsed.economie_potentielle_max = 0;
  if (marche) {
    parsed.fourchette_marche_min = marche.min;
    parsed.fourchette_marche_max = marche.max;
    console.log(`SCORE PRIX calculé: ${marche.scorePrix} (prix ${prixDemande}, fourchette ${marche.min}–${marche.max}, GPT proposait ${parsed.score_prix})`);
    parsed.score_prix = marche.scorePrix;
    parsed.prix_negocie_suggere = marche.prixNegocie;
    parsed.economie_potentielle_min = marche.ecoMin;
    parsed.economie_potentielle_max = marche.ecoMax;
    console.log(`PRIX NEGOCIE: prix ${prixDemande}, médiane ${marche.mediane} → objectif ${marche.prixNegocie} (−${(marche.reduction * 100).toFixed(1)} %)`);
  } else {
    // Pas de données marché fiables : on n'affiche pas de fourchette inventée
    parsed.fourchette_marche_min = 0;
    parsed.fourchette_marche_max = 0;
    console.log('Fourchette marché : données insuffisantes (pas de fourchette affichée)');
  }
  const fourchMax = parseInt(parsed.fourchette_marche_max) || 0;
  const mediane = marche ? marche.mediane : 0;

  // ── VERDICT : prix ET fiabilité ET red flags ──
  const redFlags = (parsed.red_flags || []).filter(r => r && String(r).trim());
  const fiab = parsed.score_fiabilite;
  const normVerdict = (v) => {
    const x = String(v || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    return x === 'ACHETER' ? 'ACHETER' : x === 'EVITER' ? 'ÉVITER' : 'NÉGOCIER';
  };
  const verdictGPT = normVerdict(parsed.verdict);
  let verdict, raison;
  if (fourchMax > 0 && prixDemande > fourchMax * 1.15) { verdict = 'ÉVITER'; raison = 'prix_trop_eleve'; }
  else if (fiab <= 3 || (redFlags.length > 0 && fiab <= 4)) { verdict = 'ÉVITER'; raison = 'fiabilite'; }
  else if (mediane > 0) {
    // ACHETER = vraie bonne affaire : plus la fiabilité est haute, moins l'écart sous la médiane doit être grand
    const bonPrix = (fiab >= 8 && prixDemande <= mediane) ||
                    (fiab >= 7 && prixDemande <= mediane * 0.97) ||
                    (fiab >= 6 && prixDemande <= mediane * 0.95);
    if (bonPrix && redFlags.length === 0) { verdict = 'ACHETER'; raison = 'bon_prix'; }
    else if (prixDemande > mediane) { verdict = 'NÉGOCIER'; raison = 'prix_au_dessus'; }
    else { verdict = 'NÉGOCIER'; raison = 'a_verifier'; }
  } else {
    verdict = verdictGPT;
    if (verdict === 'ACHETER' && (fiab < 7 || redFlags.length > 0)) verdict = 'NÉGOCIER';
    raison = verdict === verdictGPT ? null : 'a_verifier';
  }
  const niveauFiab = {
    fr: fiab >= 8 ? 'très bonne fiabilité' : fiab >= 7 ? 'bonne fiabilité' : 'fiabilité correcte',
    de: fiab >= 8 ? 'sehr gute Zuverlässigkeit' : fiab >= 7 ? 'gute Zuverlässigkeit' : 'ordentliche Zuverlässigkeit',
    it: fiab >= 8 ? 'ottima affidabilità' : fiab >= 7 ? 'buona affidabilità' : 'affidabilità discreta',
    en: fiab >= 8 ? 'very good reliability' : fiab >= 7 ? 'good reliability' : 'decent reliability'
  };
  const resumes = {
    fr: { prix_trop_eleve: 'Prix nettement au-dessus de la valeur du marché suisse.', fiabilite: 'Fiabilité insuffisante ou problème grave signalé — achat risqué.', bon_prix: `Prix inférieur à la médiane du marché (${mediane.toLocaleString('de-CH')} CHF) et ${niveauFiab.fr}.`, prix_au_dessus: `Prix au-dessus de la médiane du marché (${mediane.toLocaleString('de-CH')} CHF) — négociation recommandée.`, a_verifier: 'Points importants à vérifier avant l\'achat.' },
    de: { prix_trop_eleve: 'Preis deutlich über dem Schweizer Marktwert.', fiabilite: 'Ungenügende Zuverlässigkeit oder schwerwiegendes Problem gemeldet — riskanter Kauf.', bon_prix: `Preis unter dem Marktmedian (${mediane.toLocaleString('de-CH')} CHF) und ${niveauFiab.de}.`, prix_au_dessus: `Preis über dem Marktmedian (${mediane.toLocaleString('de-CH')} CHF) — Verhandlung empfohlen.`, a_verifier: 'Wichtige Punkte vor dem Kauf prüfen.' },
    it: { prix_trop_eleve: 'Prezzo nettamente superiore al valore del mercato svizzero.', fiabilite: 'Affidabilità insufficiente o problema grave segnalato — acquisto rischioso.', bon_prix: `Prezzo inferiore alla mediana di mercato (${mediane.toLocaleString('it-CH')} CHF) e ${niveauFiab.it}.`, prix_au_dessus: `Prezzo superiore alla mediana di mercato (${mediane.toLocaleString('it-CH')} CHF) — trattativa consigliata.`, a_verifier: 'Punti importanti da verificare prima dell\'acquisto.' },
    en: { prix_trop_eleve: 'Price well above Swiss market value.', fiabilite: 'Insufficient reliability or serious issue reported — risky purchase.', bon_prix: `Price below the market median (${mediane.toLocaleString('en-US')} CHF) with ${niveauFiab.en}.`, prix_au_dessus: `Price above the market median (${mediane.toLocaleString('en-US')} CHF) — negotiation recommended.`, a_verifier: 'Important points to check before buying.' }
  };
  if (raison && (verdict !== verdictGPT || !parsed.resume_verdict)) {
    parsed.resume_verdict = (resumes[langue] || resumes.fr)[raison];
  }
  console.log(`VERDICT: ${verdict} (GPT: ${verdictGPT}, raison: ${raison || 'IA'}, fiabilité ${fiab}, red flags ${redFlags.length}, prix ${prixDemande}, médiane ${mediane || '—'})`);
  parsed.verdict = verdict;

  parsed.score_global = Math.round((parsed.score_prix + parsed.score_fiabilite + parsed.score_entretien) / 3);

  // Taxe (interne, non affichée dans le PDF) — uniquement avec le CO2 réel de l'annonce
  parsed.taxe_cantonale_ge = estimerTaxe(co2Final, parsed.carburant);

  // Configurer la langue pour la traduction des options
  setLangue(langue || 'fr');

  // FIX OPTIONS: prioriser scraping, fallback GPT si scraping vide
  if (scrapedData.options && scrapedData.options.length > 0) {
    parsed.options = scrapedData.options
      .map(o => traduireOption(o))
      .filter(o => o !== null);
    console.log('OPTIONS injectées depuis scraping:', parsed.options.length, 'options');
  } else {
    // Fallback: utiliser les options GPT (extraites du texte brut)
    if (parsed.options && parsed.options.length > 0) {
      parsed.options = parsed.options
        .map(o => traduireOption(o))
        .filter(o => o !== null);
      console.log('OPTIONS depuis GPT (fallback texte brut):', parsed.options.length, 'options');
    } else {
      // Dernier recours: options vides
      parsed.options = [];
      console.log('AVERTISSEMENT: Aucune option disponible (scraping ET GPT vides)');
    }
  }

  // Nettoyer les libellés : caractères cassés et préfixes de catégorie ("Assist: ", "Airbag: "…)
  if (parsed.options && parsed.options.length > 0) {
    parsed.options = parsed.options.map(o => {
      let t = reparerCaracteres(String(o || '')).replace(/\s+/g, ' ').trim();
      t = t.replace(/^[A-Za-zÀ-ÿ]{3,14}\s*:\s*(?=\S)/, '');
      return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
    }).filter(Boolean);
  }
  // Dédoublonner les options
  if (parsed.options && parsed.options.length > 0) {
    const seen = new Set();
    parsed.options = parsed.options.filter(o => {
      if (!o) return false;
      const key = o.toLowerCase().trim();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    console.log('OPTIONS après dédoublonnage:', parsed.options.length);
  }

  // Nettoyer puissance
  parsed.puissance = nettoyerPuissance(parsed.puissance);

  // Limiter strictement les quantités
  // Filtrer les points négatifs interdits
  const mots_interdits = ['kilométrage', 'kilometrage', 'consommation de carburant', 'consommation élevée', 'km élevé', 'km important'];
  if (parsed.points_negatifs) {
    parsed.points_negatifs = parsed.points_negatifs.filter(p =>
      !mots_interdits.some(mot => p.toLowerCase().includes(mot))
    );
    // RÈGLE COHÉRENCE PRIX : si verdict ACHETER ou score_prix >= 7, supprimer les points négatifs prix
    const motsPrix = ['prix au-dessus', 'prix élevé', 'au-dessus du marché', 'au-dessus de la fourchette', 'prix légèrement élevé', 'légèrement au-dessus', 'au-dessus de la moyenne', 'supérieur au marché', 'prix supérieur'];
    if ((parsed.score_prix || 0) >= 7 || parsed.verdict === 'ACHETER') {
      parsed.points_negatifs = parsed.points_negatifs.filter(p =>
        !motsPrix.some(mot => p.toLowerCase().includes(mot))
      );
    }
    // Si verdict ACHETER grâce au prix, ajouter ce point positif réel (dans la langue du rapport)
    if (parsed.verdict === 'ACHETER' && mediane > 0) {
      const motsPrixPos = /prix|marché|affaire|preis|markt|prezzo|mercato|price|market/i;
      const dejaPositifPrix = (parsed.points_positifs || []).some(p => motsPrixPos.test(p));
      if (!dejaPositifPrix) {
        const pointsPrix = {
          fr: `Prix demandé inférieur à la médiane du marché (${mediane.toLocaleString('de-CH')} CHF)`,
          de: `Verlangter Preis unter dem Marktmedian (${mediane.toLocaleString('de-CH')} CHF)`,
          it: `Prezzo richiesto inferiore alla mediana di mercato (${mediane.toLocaleString('it-CH')} CHF)`,
          en: `Asking price below the market median (${mediane.toLocaleString('en-US')} CHF)`
        };
        parsed.points_positifs = [pointsPrix[langue] || pointsPrix.fr, ...(parsed.points_positifs || [])].slice(0, 3);
      }
    }
    // (supprimé : ajout automatique de points négatifs génériques pour arriver à 3 — on n'affiche que des points réels)
  }
  // Nettoyer verdict_texte et conseil_achat
  // Traduction des données brutes selon la langue
  const dataTranslations = {
    de: {
      'Essence': 'Benzin', 'Diesel': 'Diesel', 'Électrique': 'Elektrisch', 'Hybride': 'Hybrid',
      'Automatique': 'Automatisch', 'Manuelle': 'Manuell', 'Automatique (DCT)': 'Automatisch (DCT)',
      '4 roues motrices': 'Allradantrieb', 'Traction avant': 'Frontantrieb', 'Propulsion': 'Hinterradantrieb',
    },
    it: {
      'Essence': 'Benzina', 'Diesel': 'Diesel', 'Électrique': 'Elettrico', 'Hybride': 'Ibrido',
      'Automatique': 'Automatico', 'Manuelle': 'Manuale', 'Automatique (DCT)': 'Automatico (DCT)',
      '4 roues motrices': 'Trazione integrale', 'Traction avant': 'Trazione anteriore', 'Propulsion': 'Trazione posteriore',
    },
    en: {
      'Essence': 'Petrol', 'Diesel': 'Diesel', 'Électrique': 'Electric', 'Hybride': 'Hybrid',
      'Automatique': 'Automatic', 'Manuelle': 'Manual', 'Automatique (DCT)': 'Automatic (DCT)',
      '4 roues motrices': 'All-wheel drive', 'Traction avant': 'Front-wheel drive', 'Propulsion': 'Rear-wheel drive',
    }
  };

  if (langue !== 'fr' && dataTranslations[langue]) {
    const dt = dataTranslations[langue];
    if (dt[parsed.carburant]) parsed.carburant = dt[parsed.carburant];
    if (dt[parsed.boite]) parsed.boite = dt[parsed.boite];
    if (dt[parsed.transmission]) parsed.transmission = dt[parsed.transmission];
    // Traduire points positifs qui contiennent des mots français
    if (parsed.points_positifs) parsed.points_positifs = parsed.points_positifs.map(p => {
      for (const [fr, trad] of Object.entries(dt)) p = p.replace(new RegExp(fr, 'g'), trad);
      return p;
    });
  }

  // Traduction des termes techniques récurrents
  const termesDict = {
    de: {
      'Culasse remplacée': 'Zylinderkopf ersetzt',
      'Boîte DCT fragile': 'DCT-Getriebe anfällig',
      'Culasse': 'Zylinderkopf',
      'culasse': 'Zylinderkopf',
      'boîte DCT': 'DCT-Getriebe',
      'Négocier': 'Verhandeln',
    },
    it: {
      'Culasse remplacée': 'Testata sostituita',
      'Boîte DCT fragile': 'Cambio DCT fragile',
      'Culasse': 'Testata',
      'culasse': 'testata',
    },
    en: {
      'Culasse remplacée': 'Cylinder head replaced',
      'Boîte DCT fragile': 'DCT gearbox fragile',
      'Culasse': 'Cylinder head',
      'culasse': 'cylinder head',
    }
  };

  const traduireTermes = (txt) => {
    if (!txt || !termesDict[parsed.langue || langue]) return txt;
    let result = txt;
    for (const [fr, trad] of Object.entries(termesDict[parsed.langue || langue] || {})) {
      result = result.replace(new RegExp(fr, 'g'), trad);
    }
    return result;
  };

  // Appliquer traduction aux champs texte
  if (langue !== 'fr') {
    if (parsed.red_flags) parsed.red_flags = parsed.red_flags.map(traduireTermes);
    if (parsed.points_negatifs) parsed.points_negatifs = parsed.points_negatifs.map(traduireTermes);
    if (parsed.points_positifs) parsed.points_positifs = parsed.points_positifs.map(traduireTermes);
    if (parsed.verdict_texte) parsed.verdict_texte = traduireTermes(parsed.verdict_texte);
  }

  const nettoyerTexte = (txt) => {
    if (!txt) return txt;
    return txt
      .replace(/en raison du kilométrage[^.]*\.?/gi, '')
      .replace(/compte tenu du kilométrage[^.]*\.?/gi, '')
      .replace(/le kilométrage[^.]*\.?/gi, '')
      .replace(/du kilométrage[^.]*\.?/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  };
  // Nettoyer la description vendeur — enlever les éléments de navigation AutoScout24
  if (parsed.description_vendeur) {
    parsed.description_vendeur = parsed.description_vendeur
      .replace(/À vendre Rechercher Vendre Estimer.*?(?=\n|$)/gi, '')
      .replace(/Rechercher Vendre Estimer Assurer.*?(?=\n|$)/gi, '')
      .replace(/Se connecter FR Retour.*?(?=\n|$)/gi, '')
      .replace(/Partager Imprimer.*?(?=\n|$)/gi, '')
      .replace(/Comparer les assurances.*?(?=\n|$)/gi, '')
      .replace(/Nos partenaires Fournisseur.*?(?=\n|$)/gi, '')
      .replace(/Heures d.ouverture.*$/si, '')
      .replace(/Lun \d{2}:\d{2}.*$/si, '')
      .replace(/Avis du fournisseur.*$/si, '')
      .replace(/Afficher tous les avis.*$/si, '')
      .replace(/Signaler cette annonce.*$/si, '')
      .replace(/Listing ID:.*$/si, '')
      .replace(/\d{3}\s*\d{3}\s*\d{2}\s*\d{2}/g, '') // numéros de téléphone
      .replace(/https?:\/\/\S+/g, '') // URLs
      .replace(/CHF&nbsp;[\d''.–]+/g, '') // prix dupliqués
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (parsed.description_vendeur.length < 20) parsed.description_vendeur = 'Non communiquée';
  }

  if (parsed.conseil_achat) {
    parsed.conseil_achat = nettoyerTexte(parsed.conseil_achat);
    // Corriger conseil_achat tronqué (phrase coupée sans ponctuation finale)
    const ca = parsed.conseil_achat;
    if (ca && ca.length > 10 && !/[.!?»]$/.test(ca.trim())) {
      // Couper à la dernière phrase complète
      const lastDot = Math.max(ca.lastIndexOf('.'), ca.lastIndexOf('!'), ca.lastIndexOf('?'));
      if (lastDot > ca.length * 0.4) {
        parsed.conseil_achat = ca.substring(0, lastDot + 1).trim();
        console.log('CONSEIL_ACHAT tronqué corrigé — coupé à la dernière phrase complète');
      }
    }
  }
  if (parsed.verdict_texte) parsed.verdict_texte = nettoyerTexte(parsed.verdict_texte);

  // Supprimer mention Phase 2 si véhicule récent (<4 ans)
  const anneeVehicule = parseInt(parsed.annee) || 0;
  const vehiculeRecent = anneeVehicule >= 2022;
  if (vehiculeRecent && parsed.conseil_achat) {
    parsed.conseil_achat = parsed.conseil_achat
      .replace(/[^.]*[Pp]hase\s*2[^.]*\./g, '')
      .replace(/[^.]*génération suivante[^.]*\./g, '')
      .replace(/[^.]*version plus récente[^.]*\./g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    console.log('Phase 2 supprimée du conseil — véhicule récent:', anneeVehicule);
  }

  // Corriger conseil_achat si score_prix >= 7 ou verdict ACHETER : supprimer toute mention prix élevé/au-dessus
  if (((parsed.score_prix || 0) >= 7 || parsed.verdict === 'ACHETER') && parsed.conseil_achat) {
    const motsPrixCA = [
      'légèrement au-dessus', 'au-dessus de la moyenne', 'prix élevé',
      'prix demandé est élevé', 'au-dessus du marché', 'prix est légèrement',
      'prix légèrement', 'un peu au-dessus', 'légèrement supérieur au marché',
      'supérieur au marché', 'supérieur à la moyenne', 'au-dessus de la cote',
      'légèrement surévalué', 'légèrement surestimé', 'prix au-dessus'
    ];
    motsPrixCA.forEach(mot => {
      parsed.conseil_achat = parsed.conseil_achat.replace(
        new RegExp(`[^.!?]*${mot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^.!?]*[.!?]?`, 'gi'), ''
      ).trim();
    });
    parsed.conseil_achat = parsed.conseil_achat.replace(/\s{2,}/g, ' ').trim();
    console.log('CONSEIL_ACHAT : mention prix élevé supprimée (score_prix=' + parsed.score_prix + ')');
    // Si verdict ACHETER, ajouter mention prix bien positionné si pas déjà présente
    if (parsed.verdict === 'ACHETER' && parsed.conseil_achat) {
      const medianeCA = mediane;
      const dejaPositif = parsed.conseil_achat.toLowerCase().includes('inférieur') ||
        parsed.conseil_achat.toLowerCase().includes('bonne affaire') ||
        parsed.conseil_achat.toLowerCase().includes('bien positionné');
      if (false && !dejaPositif && medianeCA > 0 && langue === 'fr') { // désactivé : texte forcé, redondant
        parsed.conseil_achat = `Prix demandé de ${prixDemande.toLocaleString()} CHF inférieur à la médiane du marché (${medianeCA.toLocaleString()} CHF) — bonne affaire. ` + parsed.conseil_achat;
      }
    }
  }

  // Supprimer problèmes vagues sur véhicules quasi neufs (<3 ans, <30000 km)
  const kmVehicule = km || parseInt(String(parsed.kilometrage || '').replace(/[^\d]/g, '')) || 0;
  if (anneeVehicule >= 2023 && kmVehicule < 30000 && parsed.problemes_connus_modele) {
    const problemesVagues = ['capteurs de stationnement', 'usure normale', 'capteurs', 'stationnement'];
    parsed.problemes_connus_modele = parsed.problemes_connus_modele.filter(p =>
      !problemesVagues.some(v => p.toLowerCase().includes(v))
    );
    console.log('Problèmes vagues supprimés pour véhicule quasi neuf');
  }

  if (parsed.points_positifs?.length > 3) parsed.points_positifs = parsed.points_positifs.slice(0, 3);
  if (parsed.points_negatifs?.length > 3) parsed.points_negatifs = parsed.points_negatifs.slice(0, 3);
  if (parsed.checklist_visite?.length > 4) parsed.checklist_visite = parsed.checklist_visite.slice(0, 4);
  if (parsed.questions_vendeur?.length > 3) parsed.questions_vendeur = parsed.questions_vendeur.slice(0, 3);
  // ── INJECTION DIRECTE TAVILY : problèmes connus sans passer par GPT ──
  // GPT retourne toujours [] pour ce champ — on injecte ici les données réelles Tavily
  if (Array.isArray(tavilyProblemes) && tavilyProblemes.length > 0) {
    parsed.problemes_connus_modele = tavilyProblemes.slice(0, 4);
    console.log('PROBLÈMES injectés depuis Tavily (bypass GPT):', parsed.problemes_connus_modele.length);
  } else {
    parsed.problemes_connus_modele = [];
    console.log('PROBLÈMES : aucun trouvé par Tavily → tableau vide');
  }
  // Numéros de rappel officiels
  parsed.numeros_rappel = tavilyRappels;
  if (tavilyRappels.length > 0) console.log('RAPPELS injectés:', tavilyRappels.join(', '));

  return parsed;
}

// ─── GÉNÉRATION PDF ──────────────────────────────────────
function traduireVerdict(verdict, langue) {
  const verdicts = {
    fr: { 'ACHETER': 'ACHETER', 'NÉGOCIER': 'NÉGOCIER', 'ÉVITER': 'ÉVITER' },
    de: { 'ACHETER': 'KAUFEN', 'NÉGOCIER': 'VERHANDELN', 'ÉVITER': 'MEIDEN' },
    it: { 'ACHETER': 'ACQUISTARE', 'NÉGOCIER': 'TRATTARE', 'ÉVITER': 'EVITARE' },
    en: { 'ACHETER': 'BUY', 'NÉGOCIER': 'NEGOTIATE', 'ÉVITER': 'AVOID' }
  };
  return (verdicts[langue] || verdicts.fr)[verdict] || verdict;
}

async function genererPDF(analyse, reportNumber, url, langue = 'fr') {
  const labels = {
    fr: { marque: 'MARQUE & MODÈLE', score_global: 'SCORE GLOBAL', rapport: 'Rapport', prix: 'PRIX', fiabilite: 'FIABILITÉ', entretien: 'ENTRETIEN', annee: 'ANNÉE', km: 'KILOMÉTRAGE', prix_dem: 'PRIX DEMANDÉ', puissance: 'PUISSANCE', carburant: 'CARBURANT', boite: 'BOÎTE', transmission: 'TRANSMISSION', couleur: 'COULEUR', desc: 'DESCRIPTION VENDEUR', scores: 'DÉTAIL DES SCORES', points: 'POINTS CLÉS', options: 'ÉQUIPEMENTS & OPTIONS', couts: 'COÛTS & MARCHÉ', entretien1: 'ENTRETIEN AN 1', total3: 'TOTAL 3 ANS', co2: 'CO2 & TAXE CANTONALE', marche: 'FOURCHETTE MARCHÉ', taxe: 'Taxe: site officiel de votre canton', red: 'RED FLAGS', alerte: 'ALERTE', problemes: 'PROBLÈMES CONNUS DU MODÈLE', checklist: 'CHECKLIST VISITE', questions: 'QUESTIONS À POSER AU VENDEUR', conseil: "CONSEIL D'ACHAT", verdict: 'VERDICT FINAL', disclaimer: "Ce rapport est un outil d'aide à la décision. Il ne remplace pas une inspection physique par un professionnel." },
    de: { marque: 'MARKE & MODELL', score_global: 'GESAMTBEWERTUNG', rapport: 'Bericht', prix: 'PREIS', fiabilite: 'ZUVERLÄSSIGKEIT', entretien: 'WARTUNG', annee: 'JAHR', km: 'KILOMETERSTAND', prix_dem: 'VERLANGTER PREIS', puissance: 'LEISTUNG', carburant: 'KRAFTSTOFF', boite: 'GETRIEBE', transmission: 'ANTRIEB', couleur: 'FARBE', desc: 'VERKÄUFERBESCHREIBUNG', scores: 'BEWERTUNGSDETAILS', points: 'WICHTIGE PUNKTE', options: 'AUSSTATTUNG & OPTIONEN', couts: 'KOSTEN & MARKT', entretien1: 'WARTUNG JAHR 1', total3: 'TOTAL 3 JAHRE', co2: 'CO2 & KANTONSSTEUER', marche: 'MARKTPREISSPANNE', taxe: 'Steuer: offizielle Kantonswebsite', red: 'WARNHINWEISE', alerte: 'WARNUNG', problemes: 'BEKANNTE MODELLPROBLEME', checklist: 'BESICHTIGUNGS-CHECKLISTE', questions: 'FRAGEN AN DEN VERKÄUFER', conseil: 'KAUFEMPFEHLUNG', verdict: 'ENDURTEIL', disclaimer: 'Dieser Bericht ist ein Entscheidungshilfe-Tool. Er ersetzt keine physische Inspektion durch einen Fachmann.' },
    it: { marque: 'MARCA & MODELLO', score_global: 'PUNTEGGIO GLOBALE', rapport: 'Rapporto', prix: 'PREZZO', fiabilite: 'AFFIDABILITÀ', entretien: 'MANUTENZIONE', annee: 'ANNO', km: 'CHILOMETRAGGIO', prix_dem: 'PREZZO RICHIESTO', puissance: 'POTENZA', carburant: 'CARBURANTE', boite: 'CAMBIO', transmission: 'TRAZIONE', couleur: 'COLORE', desc: 'DESCRIZIONE VENDITORE', scores: 'DETTAGLIO PUNTEGGI', points: 'PUNTI CHIAVE', options: 'EQUIPAGGIAMENTI & OPZIONI', couts: 'COSTI & MERCATO', entretien1: 'MANUTENZIONE ANNO 1', total3: 'TOTALE 3 ANNI', co2: 'CO2 & TASSA CANTONALE', marche: 'FASCIA DI MERCATO', taxe: 'Calcola sul sito ufficiale del tuo cantone', red: 'SEGNALAZIONI', alerte: 'ATTENZIONE', problemes: 'PROBLEMI NOTI DEL MODELLO', checklist: 'CHECKLIST VISITA', questions: 'DOMANDE AL VENDITORE', conseil: "CONSIGLIO D'ACQUISTO", verdict: 'VERDETTO FINALE', disclaimer: 'Questo rapporto è uno strumento di supporto decisionale.' },
    en: { marque: 'MAKE & MODEL', score_global: 'OVERALL SCORE', rapport: 'Report', prix: 'PRICE', fiabilite: 'RELIABILITY', entretien: 'MAINTENANCE', annee: 'YEAR', km: 'MILEAGE', prix_dem: 'ASKING PRICE', puissance: 'POWER', carburant: 'FUEL', boite: 'GEARBOX', transmission: 'DRIVE', couleur: 'COLOUR', desc: 'SELLER DESCRIPTION', scores: 'SCORE DETAILS', points: 'KEY POINTS', options: 'EQUIPMENT & OPTIONS', couts: 'COSTS & MARKET', entretien1: 'MAINTENANCE YEAR 1', total3: 'TOTAL 3 YEARS', co2: 'CO2 & CANTONAL TAX', marche: 'MARKET RANGE', taxe: "Calculate on your canton's official website", red: 'RED FLAGS', alerte: 'ALERT', problemes: 'KNOWN MODEL ISSUES', checklist: 'VISIT CHECKLIST', questions: 'QUESTIONS FOR THE SELLER', conseil: 'BUYING ADVICE', verdict: 'FINAL VERDICT', disclaimer: 'This report is a decision-support tool. It does not replace a physical inspection by a professional.' }
  };
  const L = labels[langue] || labels.fr;
  const insuffisant = { fr: 'Données marché insuffisantes', de: 'Unzureichende Marktdaten', it: 'Dati di mercato insufficienti', en: 'Insufficient market data' }[langue] || 'Données marché insuffisantes';
  const nbAnn = analyse.marche_nb_annonces || 0;
  const noteEstimation = analyse.marche_source === 'as24' && nbAnn > 0
    ? ({ fr: `Médiane de ${nbAnn} annonces similaires`, de: `Median von ${nbAnn} ähnlichen Inseraten`, it: `Mediana di ${nbAnn} annunci simili`, en: `Median of ${nbAnn} similar listings` }[langue] || `Médiane de ${nbAnn} annonces similaires`)
    : ({ fr: 'Estimation · sources web', de: 'Schätzung · Webquellen', it: 'Stima · fonti web', en: 'Estimate · web sources' }[langue] || 'Estimation · sources web');
  const titreComparables = { fr: 'ANNONCES SIMILAIRES EN SUISSE', de: 'ÄHNLICHE INSERATE IN DER SCHWEIZ', it: 'ANNUNCI SIMILI IN SVIZZERA', en: 'SIMILAR LISTINGS IN SWITZERLAND' }[langue] || 'ANNONCES SIMILAIRES EN SUISSE';
  const noteComparables = { fr: 'Annonces AutoScout24 au moment du rapport — elles peuvent avoir été vendues depuis.', de: 'AutoScout24-Inserate zum Zeitpunkt des Berichts — evtl. inzwischen verkauft.', it: 'Annunci AutoScout24 al momento del rapporto — potrebbero essere già stati venduti.', en: 'AutoScout24 listings at the time of the report — they may have been sold since.' }[langue] || '';
  const nbSrc = analyse.nb_sources_fiabilite || 0;
  const noteSources = nbSrc > 0 ? ({
    fr: `Basé sur ${nbSrc} sources analysées pour ce modèle et ce moteur.`,
    de: `Basierend auf ${nbSrc} ausgewerteten Quellen zu diesem Modell und Motor.`,
    it: `Basato su ${nbSrc} fonti analizzate per questo modello e motore.`,
    en: `Based on ${nbSrc} sources analysed for this model and engine.`
  }[langue] || `Basé sur ${nbSrc} sources analysées pour ce modèle et ce moteur.`) : '';
  const montant = (v) => (Number(v) > 0 ? Number(v).toLocaleString('de-CH') : '—');
  const verdictColor = {
    'ACHETER': '#28a745', 'NÉGOCIER': '#d4a00a', 'ÉVITER': '#dc3545',
    'VERHANDELN': '#d4a00a', 'KAUFEN': '#28a745', 'MEIDEN': '#dc3545',
    'NEGOTIATE': '#d4a00a', 'BUY': '#28a745', 'AVOID': '#dc3545',
    'ACQUISTARE': '#28a745', 'TRATTARE': '#d4a00a', 'EVITARE': '#dc3545'
  };
  const colour = (score) => score >= 7 ? '#28a745' : score >= 5 ? '#d4a00a' : '#dc3545';
  const badgeMap = {
    fr: { ex: 'EXCELLENT', bien: 'BIEN ÉVALUÉ', moy: 'MOYEN', sur: 'À SURVEILLER', ev: 'À ÉVITER' },
    de: { ex: 'AUSGEZEICHNET', bien: 'GUT BEWERTET', moy: 'MITTEL', sur: 'ACHTUNG', ev: 'MEIDEN' },
    it: { ex: 'ECCELLENTE', bien: 'BEN VALUTATO', moy: 'MEDIO', sur: 'ATTENZIONE', ev: 'DA EVITARE' },
    en: { ex: 'EXCELLENT', bien: 'WELL RATED', moy: 'AVERAGE', sur: 'WATCH OUT', ev: 'AVOID' }
  };
  const bm = badgeMap[langue] || badgeMap.fr;
  const badge = (score) => score >= 8 ? bm.ex : score >= 7 ? bm.bien : score >= 5 ? bm.moy : bm.ev;
  const scoreTag = (score) => score >= 8 ? bm.ex : score >= 7 ? bm.bien : score >= 5 ? bm.moy : bm.sur;

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Noto+Emoji&display=swap" rel="stylesheet">
<style>
  @page { margin: 0; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { font-family: 'Plus Jakarta Sans', Arial, sans-serif; background: #f0f6ff; color: #0d1b35; font-size: 13px; height: auto !important; }
  .header { background: linear-gradient(135deg, #1a3a6e, #2952a3); padding: 14px 22px; border-bottom: 2px solid #00B4D8; }
  .header-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
  .logo { font-size: 18px; font-weight: 700; letter-spacing: 2px; color: #fff; }
  .logo span { color: #00B4D8; }
  .report-num { font-size: 11px; color: #b8d0f0; }
  .header-main { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
  .car-brand-label { font-size: 10px; color: #b8d0f0; letter-spacing: 3px; margin-bottom: 3px; }
  .car-brand { font-size: 26px; font-weight: 900; letter-spacing: 2px; line-height: 1.1; color: #fff; }
  .car-model { font-size: 16px; color: #00B4D8; font-weight: 700; margin-top: 3px; }
  .score-box { display: flex; flex-direction: column; align-items: center; background: rgba(255,255,255,0.1); border-radius: 10px; padding: 12px 18px; min-width: 100px; }
  .score-label { font-size: 9px; color: #b8d0f0; letter-spacing: 2px; margin-bottom: 3px; }
  .score-num { font-size: 46px; font-weight: 900; line-height: 1; }
  .score-denom { font-size: 11px; color: #b8d0f0; }
  .score-badge { margin-top: 5px; border-radius: 4px; padding: 2px 7px; font-size: 9px; font-weight: 700; color: #000; }
  .scores-bar { padding: 8px 22px; page-break-inside: avoid; background: #fff; border-bottom: 1px solid #d0e4f7; }
  .scores-bar-title { font-size: 9px; color: #5a7a9a; letter-spacing: 1px; margin-bottom: 6px; }
  .scores-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .score-item { text-align: center; }
  .score-item-label { font-size: 9px; color: #5a7a9a; letter-spacing: 1px; margin-bottom: 3px; }
  .score-item-num { font-size: 36px; font-weight: 900; line-height: 1; margin-bottom: 3px; }
  .score-bar-bg { height: 7px; background: #d0e4f7; border-radius: 4px; }
  .score-bar-fill { height: 7px; border-radius: 4px; }
  .score-item-tag { font-size: 9px; font-weight: 700; margin-top: 3px; }
  .grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); border-bottom: 1px solid #d0e4f7; page-break-inside: avoid; }
  .cell { padding: 7px 12px; border-right: 1px solid #d0e4f7; }
  .cell:last-child { border-right: none; }
  .cell-label { font-size: 9px; color: #5a7a9a; letter-spacing: 1px; margin-bottom: 3px; text-transform: uppercase; }
  .cell-value { font-size: 14px; font-weight: 700; color: #0d1b35; }
  .cell-unit { font-size: 12px; color: #5a7a9a; font-weight: 600; }
  .grid-white { background: #fff; }
  .grid-light { background: #f0f6ff; }
  .section { padding: 8px 22px; border-bottom: 1px solid #d0e4f7; page-break-inside: avoid; }
  .section-white { background: #fff; }
  .section-light { background: #f0f6ff; }
  .section-title { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
  .section-bar { width: 4px; height: 16px; border-radius: 2px; flex-shrink: 0; }
  .section-label { font-size: 12px; font-weight: 700; letter-spacing: 1px; }
  .description-box { background: #f0f6ff; border-radius: 6px; padding: 10px 12px; font-size: 12px; color: #3a5a7a; line-height: 1.55; border-left: 3px solid #1a3a6e; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
  .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 5px; }
  .point-card { background: #fff; border-radius: 5px; padding: 7px 10px; font-size: 12px; color: #0d1b35; }
  .point-card-light { background: #f0f6ff; border-radius: 5px; padding: 6px 9px; font-size: 11px; color: #0d1b35; }
  .checklist-item { background: #f0f6ff; border-radius: 5px; padding: 6px 10px; font-size: 12px; color: #0d1b35; display: flex; align-items: center; gap: 7px; margin-bottom: 3px; }
  .icon-check { display:inline-block; width:14px; height:14px; background:#28a745; border-radius:50%; color:#fff; text-align:center; line-height:14px; font-size:10px; font-weight:bold; flex-shrink:0; }
  .icon-warn { display:inline-block; width:14px; height:14px; background:#d4a00a; border-radius:50%; color:#fff; text-align:center; line-height:14px; font-size:10px; font-weight:bold; flex-shrink:0; }
  .icon-cross { display:inline-block; width:14px; height:14px; background:#dc3545; border-radius:50%; color:#fff; text-align:center; line-height:14px; font-size:10px; font-weight:bold; flex-shrink:0; }
  .icon-q { display:inline-block; width:14px; height:14px; background:#1a3a6e; border-radius:50%; color:#fff; text-align:center; line-height:14px; font-size:10px; font-weight:bold; flex-shrink:0; }
  .checklist-item-white { background: #fff; border-radius: 5px; padding: 6px 10px; font-size: 12px; color: #0d1b35; display: flex; align-items: center; gap: 7px; margin-bottom: 3px; }
  .costs-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; page-break-inside: avoid; }
  .cost-card { background: #fff; border-radius: 7px; padding: 9px; text-align: center; }
  .cost-label { font-size: 9px; color: #5a7a9a; letter-spacing: 1px; margin-bottom: 3px; }
  .cost-value { font-size: 15px; font-weight: 800; }
  .cost-note { font-size: 8px; color: #5a7a9a; margin-top: 3px; }
  .redflag-section { padding: 12px 22px; background: rgba(220,53,69,0.04); border-bottom: 2px solid #dc3545; page-break-inside: avoid; }
  .redflag-badge { background: #dc3545; border-radius: 4px; padding: 3px 10px; font-size: 10px; font-weight: 700; color: #fff; display: inline-block; margin-bottom: 8px; }
  .redflag-card { background: rgba(220,53,69,0.06); border-radius: 7px; padding: 8px; border: 1px solid rgba(220,53,69,0.2); margin-bottom: 5px; }
  .redflag-title { font-size: 12px; font-weight: 600; color: #dc3545; }
  .verdict-section { padding: 18px 22px; display: flex; justify-content: space-between; align-items: center; background: linear-gradient(135deg, #1a3a6e, #2952a3); page-break-inside: avoid; page-break-before: avoid; }
  .verdict-label { font-size: 10px; color: #b8d0f0; letter-spacing: 2px; margin-bottom: 5px; }
  .verdict-value { font-size: 38px; font-weight: 900; letter-spacing: 2px; }
  .verdict-desc { font-size: 11px; color: #b8d0f0; margin-top: 6px; max-width: 280px; line-height: 1.5; }
  .footer { padding: 10px 22px; background: #1a3a6e; border-top: 1px solid #2952a3; font-size: 9px; color: #b8d0f0; text-align: center; line-height: 1.6; page-break-inside: avoid; }
</style>
</head>
<body>

  <div class="header">
    <div class="header-top">
      <div class="logo">EASY<span>CAR</span>CHECK</div>
      <div class="report-num">${L.rapport} #${reportNumber} · ${(() => { const d = new Date(); const mois = { fr: ['JANV.','FÉV.','MARS','AVR.','MAI','JUIN','JUIL.','AOÛT','SEPT.','OCT.','NOV.','DÉC.'], de: ['JAN.','FEB.','MÄR.','APR.','MAI','JUN.','JUL.','AUG.','SEP.','OKT.','NOV.','DEZ.'], it: ['GEN.','FEB.','MAR.','APR.','MAG.','GIU.','LUG.','AGO.','SET.','OTT.','NOV.','DIC.'], en: ['JAN.','FEB.','MAR.','APR.','MAY','JUN.','JUL.','AUG.','SEP.','OCT.','NOV.','DEC.'] }; const m = (mois[langue] || mois.fr)[d.getMonth()]; return m + ' ' + d.getFullYear(); })()}</div>
    </div>
    <div class="header-main">
      <div>
        <div class="car-brand-label">${L.marque}</div>
        <div class="car-brand">${analyse.marque?.toUpperCase()}</div>
        <div class="car-model">${analyse.modele?.toUpperCase()}</div>
      </div>
      <div class="score-box" style="border: 2px solid ${colour(analyse.score_global)};">
        <div class="score-label">${L.score_global}</div>
        <div class="score-num" style="color: ${colour(analyse.score_global)};">${analyse.score_global}</div>
        <div class="score-denom">/10</div>
        <div class="score-badge" style="background: ${colour(analyse.score_global)};">${badge(analyse.score_global)}</div>
      </div>
    </div>
  </div>

  <div class="scores-bar">
    <div class="scores-bar-title">${L.scores}</div>
    <div class="scores-grid">
      <div class="score-item">
        <div class="score-item-label">${L.prix}</div>
        <div class="score-item-num" style="color:${colour(analyse.score_prix)};">${analyse.score_prix}</div>
        <div class="score-bar-bg"><div class="score-bar-fill" style="width:${analyse.score_prix*10}%;background:${colour(analyse.score_prix)};"></div></div>
        <div class="score-item-tag" style="color:${colour(analyse.score_prix)};">${scoreTag(analyse.score_prix)}</div>
        ${analyse.justification_prix ? `<div style="font-size:9.5px; color:#3a5a7a; line-height:1.4; margin-top:4px; padding:0 4px;">${analyse.justification_prix}</div>` : ''}
      </div>
      <div class="score-item">
        <div class="score-item-label">${L.fiabilite}</div>
        <div class="score-item-num" style="color:${colour(analyse.score_fiabilite)};">${analyse.score_fiabilite}</div>
        <div class="score-bar-bg"><div class="score-bar-fill" style="width:${analyse.score_fiabilite*10}%;background:${colour(analyse.score_fiabilite)};"></div></div>
        <div class="score-item-tag" style="color:${colour(analyse.score_fiabilite)};">${scoreTag(analyse.score_fiabilite)}</div>
        ${analyse.justification_fiabilite ? `<div style="font-size:9.5px; color:#3a5a7a; line-height:1.4; margin-top:4px; padding:0 4px;">${analyse.justification_fiabilite}</div>` : ''}
      </div>
      <div class="score-item">
        <div class="score-item-label">${L.entretien}</div>
        <div class="score-item-num" style="color:${colour(analyse.score_entretien)};">${analyse.score_entretien}</div>
        <div class="score-bar-bg"><div class="score-bar-fill" style="width:${analyse.score_entretien*10}%;background:${colour(analyse.score_entretien)};"></div></div>
        <div class="score-item-tag" style="color:${colour(analyse.score_entretien)};">${scoreTag(analyse.score_entretien)}</div>
        ${analyse.justification_entretien ? `<div style="font-size:9.5px; color:#3a5a7a; line-height:1.4; margin-top:4px; padding:0 4px;">${analyse.justification_entretien}</div>` : ''}
      </div>
    </div>
  </div>

  <div class="grid-4 grid-white">
    <div class="cell"><div class="cell-label">${L.annee}</div><div class="cell-value">${analyse.annee}</div></div>
    <div class="cell"><div class="cell-label">${L.km}</div><div class="cell-value">${analyse.kilometrage} <span class="cell-unit">km</span></div></div>
    <div class="cell"><div class="cell-label">${L.prix_dem}</div><div class="cell-value" style="color:#1a3a6e;">${analyse.prix} <span class="cell-unit">CHF</span></div></div>
    <div class="cell"><div class="cell-label">${L.puissance}</div><div class="cell-value">${analyse.puissance}</div></div>
  </div>

  <div class="grid-4 grid-light" style="border-bottom:1px solid #d0e4f7;">
    <div class="cell"><div class="cell-label">${L.carburant}</div><div class="cell-value">${analyse.carburant}</div></div>
    <div class="cell"><div class="cell-label">${L.boite}</div><div class="cell-value">${analyse.boite}</div></div>
    <div class="cell"><div class="cell-label">${L.transmission}</div><div class="cell-value">${analyse.transmission}</div></div>
    <div class="cell"><div class="cell-label">${L.couleur}</div><div class="cell-value">${analyse.couleur}</div></div>
  </div>

  <div class="section section-white">
    <div class="section-title"><div class="section-bar" style="background:#1a3a6e;"></div><div class="section-label" style="color:#1a3a6e;">${L.desc}</div></div>
    <div class="description-box">${analyse.description_vendeur}</div>
  </div>

  <div class="section section-light">
    <div class="section-title"><div class="section-bar" style="background:#28a745;"></div><div class="section-label" style="color:#28a745;">${L.points}</div></div>
    <div class="grid-2">
      ${(analyse.points_positifs || []).map(p => `<div class="point-card" style="border-left:4px solid #28a745; padding:8px 10px; color:#0d1b35; font-size:12px;"><span style="color:#28a745; font-weight:700; margin-right:6px;">OK</span>${p}</div>`).join('')}
      ${(analyse.points_negatifs || []).map(p => `<div class="point-card" style="border-left:4px solid #d4a00a; padding:8px 10px; color:#0d1b35; font-size:12px;"><span style="color:#d4a00a; font-weight:700; margin-right:6px;">ATT.</span>${p}</div>`).join('')}
    </div>
  </div>

  ${analyse.options?.length > 0 ? `
  <div class="section section-white">
    <div class="section-title"><div class="section-bar" style="background:#1a3a6e;"></div><div class="section-label" style="color:#1a3a6e;">${L.options}</div></div>
    <table style="width:100%; border-collapse:separate; border-spacing:0 3px;">
      ${(() => {
        const opts = (analyse.options || []).slice(0, 24);
        const rows = [];
        for (let i = 0; i < opts.length; i += 3) {
          const a = opts[i] || '';
          const b = opts[i+1] || '';
          const c = opts[i+2] || '';
          rows.push(`<tr>
            <td style="width:33%; padding:4px 7px; background:#f0f6ff; font-size:11.5px; color:#0d1b35; border-radius:3px;">&#9679; ${a}</td>
            <td style="width:2px;"></td>
            <td style="width:33%; padding:4px 7px; background:${b ? '#f0f6ff' : 'transparent'}; font-size:11.5px; color:#0d1b35; border-radius:3px;">${b ? '&#9679; ' + b : ''}</td>
            <td style="width:2px;"></td>
            <td style="width:33%; padding:4px 7px; background:${c ? '#f0f6ff' : 'transparent'}; font-size:11.5px; color:#0d1b35; border-radius:3px;">${c ? '&#9679; ' + c : ''}</td>
          </tr>`);
        }
        return rows.join('');
      })()}
    </table>
  </div>` : ''}

  <div class="section section-light">
    <div class="section-title"><div class="section-bar" style="background:#d4a00a;"></div><div class="section-label" style="color:#d4a00a;">${L.couts}</div></div>
    <div class="costs-grid">
      <div class="cost-card" style="border-top:3px solid #d4a00a;">
        <div class="cost-label">${L.entretien1}</div>
        <div class="cost-value" style="color:#d4a00a;">~${montant(analyse.cout_entretien_annee1)} CHF</div>
      </div>
      <div class="cost-card" style="border-top:3px solid #d4a00a;">
        <div class="cost-label">${L.total3}</div>
        <div class="cost-value" style="color:#d4a00a;">~${montant(analyse.cout_total_3ans)} CHF</div>
      </div>
      <div class="cost-card" style="border-top:3px solid #1a3a6e;">
        <div class="cost-label">${L.co2}</div>
        ${analyse.co2
          ? `<div class="cost-value" style="color:#1a3a6e;">${analyse.co2} g/km</div>
             <div class="cost-note" style="font-size:9px; color:#5a7a9a; margin-top:3px;">${L.taxe}</div>`
          : `<div class="cost-value" style="color:#5a7a9a; font-size:13px;">—</div>
             <div class="cost-note" style="font-size:9px; color:#5a7a9a; margin-top:3px;">${L.taxe}</div>`
        }
      </div>
      <div class="cost-card" style="border-top:3px solid #5a7a9a;">
        <div class="cost-label">${L.marche}</div>
        ${analyse.fourchette_marche_max > 0
          ? `<div class="cost-value" style="color:#5a7a9a;font-size:12px;">${montant(analyse.fourchette_marche_min)} – ${montant(analyse.fourchette_marche_max)} CHF</div><div class="cost-note" style="font-size:9px; color:#5a7a9a; margin-top:3px;">${noteEstimation}</div>`
          : `<div class="cost-value" style="color:#5a7a9a;font-size:13px;">—</div><div class="cost-note" style="font-size:9px; color:#5a7a9a; margin-top:3px;">${insuffisant}</div>`}
      </div>
    </div>
  </div>

  ${(analyse.comparables || []).length > 0 ? `
  <div class="section section-white">
    <div class="section-title"><div class="section-bar" style="background:#5a7a9a;"></div><div class="section-label" style="color:#5a7a9a;">${titreComparables}</div></div>
    ${analyse.comparables.map(c => `<div class="checklist-item-white" style="border-left:3px solid #5a7a9a; justify-content:space-between;"><span>${c.titre || ''}${c.annee ? ' · ' + c.annee : ''} · ${montant(c.km)} km</span><span style="font-weight:700; white-space:nowrap;">${c.lien ? `<a href="${c.lien}" style="color:#1a3a6e; text-decoration:none;">${montant(c.prix)} CHF</a>` : `${montant(c.prix)} CHF`}</span></div>`).join('')}
    <div style="font-size:9px; color:#5a7a9a; margin-top:4px;">${noteComparables}</div>
  </div>` : ''}

  ${analyse.red_flags?.length > 0 ? `
  <div class="redflag-section">
    <div class="redflag-badge">${L.red}</div>
    ${analyse.red_flags.map(r => `<div class="redflag-card"><div class="redflag-title" style="color:#dc3545; font-weight:700;">${L.alerte} — ${r}</div></div>`).join('')}
  </div>` : ''}

  ${analyse.problemes_connus_modele?.length > 0 ? `
  <div class="section section-white">
    <div class="section-title"><div class="section-bar" style="background:#d4a00a;"></div><div class="section-label" style="color:#d4a00a;">${L.problemes}</div></div>${noteSources ? `<div style="font-size:9.5px; color:#5a7a9a; margin:-3px 0 6px 12px;">${noteSources}</div>` : ''}
    ${analyse.problemes_connus_modele.map(p => `<div class="checklist-item-white" style="border-left:3px solid #d4a00a;"><span style="color:#d4a00a; font-weight:700; margin-right:6px;">!</span>${p}</div>`).join('')}
    ${analyse.numeros_rappel?.length > 0 ? `<div style="margin-top:8px; padding:8px 12px; background:#fff8e1; border-left:3px solid #d4a00a; border-radius:4px; font-size:11px; color:#7a5800;"><span style="font-weight:700;">⚠ Rappel(s) constructeur officiel(s) :</span> ${analyse.numeros_rappel.join(' · ')} — Vérifier auprès du concessionnaire si effectué.</div>` : ''}
  </div>` : `${analyse.numeros_rappel?.length > 0 ? `
  <div class="section section-white">
    <div class="section-title"><div class="section-bar" style="background:#d4a00a;"></div><div class="section-label" style="color:#d4a00a;">${L.problemes}</div></div>${noteSources ? `<div style="font-size:9.5px; color:#5a7a9a; margin:-3px 0 6px 12px;">${noteSources}</div>` : ''}
    <div style="padding:8px 12px; background:#fff8e1; border-left:3px solid #d4a00a; border-radius:4px; font-size:11px; color:#7a5800;"><span style="font-weight:700;">⚠ Rappel(s) constructeur officiel(s) :</span> ${analyse.numeros_rappel.join(' · ')} — Vérifier auprès du concessionnaire si effectué.</div>
  </div>` : ''}`}

  <div class="section section-light">
    <div class="section-title"><div class="section-bar" style="background:#28a745;"></div><div class="section-label" style="color:#28a745;">${L.checklist}</div></div>
    ${(analyse.checklist_visite || []).map(c => `<div class="checklist-item" style="border-left:3px solid #28a745;"><span style="color:#28a745; font-weight:700; margin-right:6px;">></span>${c}</div>`).join('')}
  </div>

  <div>
  <div class="section section-white">
    <div class="section-title"><div class="section-bar" style="background:#1a3a6e;"></div><div class="section-label" style="color:#1a3a6e;">${L.questions}</div></div>
    ${(analyse.questions_vendeur || []).map(q => `<div class="checklist-item-white" style="border-left:3px solid #1a3a6e;"><span style="color:#1a3a6e; font-weight:700; margin-right:6px;">?</span>${q}</div>`).join('')}
  </div>
    <div class="verdict-section">
      <div>
        <div class="verdict-label">${L.verdict}</div>
        <div class="verdict-value" style="color:${verdictColor[analyse.verdict] || '#d4a00a'};">${traduireVerdict(analyse.verdict, langue)}</div>
        ${analyse.resume_verdict ? `<div class="verdict-desc">${analyse.resume_verdict}</div>` : ''}
      </div>
      <div style="text-align:right;">
        <div style="font-size:10px;color:#b8d0f0;margin-bottom:4px;">${langue === "de" ? "EMPF. PREIS" : langue === "it" ? "PREZZO SUGGERITO" : langue === "en" ? "SUGGESTED PRICE" : "PRIX SUGGÉRÉ"}</div>
        <div style="font-size:38px;font-weight:900;color:#fff;">${analyse.prix_negocie_suggere > 0 ? montant(analyse.prix_negocie_suggere) + ' CHF' : '—'}</div>
        <div style="font-size:10px;color:#00B4D8;margin-top:4px;">${!(analyse.prix_negocie_suggere > 0) ? insuffisant : analyse.verdict === 'ACHETER' ? (langue === "de" ? "✓ Preis im Markt" : langue === "it" ? "✓ Prezzo nel mercato" : langue === "en" ? "✓ Price within market" : "✓ Prix dans le marché") : `${langue === "de" ? "↓ Ersparnis :" : langue === "it" ? "↓ Risparmio :" : langue === "en" ? "↓ Savings :" : "↓ Économie :"} ${analyse.economie_potentielle_min === analyse.economie_potentielle_max ? '~' + montant(analyse.economie_potentielle_min) : montant(analyse.economie_potentielle_min) + ' – ' + montant(analyse.economie_potentielle_max)} CHF`}</div>
      </div>
    </div>

    ${analyse.conseil_achat ? `
    <div class="section section-white">
      <div class="section-title"><div class="section-bar" style="background:#1a6e3a;"></div><div class="section-label" style="color:#1a6e3a;">${L.conseil}</div></div>
      <p style="font-size:12px; color:#0d1b35; line-height:1.7; padding:4px 0;">${analyse.conseil_achat}</p>
    </div>` : ''}

    <div style="margin:12px 22px 0 22px; padding:18px 20px; background:linear-gradient(135deg,#1a3a6e,#2952a3); border-radius:10px; color:#fff;">
      <div style="font-size:11px; font-weight:700; letter-spacing:1px; color:#00B4D8; margin-bottom:10px; text-transform:uppercase;">${langue === 'de' ? 'Über EasyCarCheck' : langue === 'it' ? 'Su EasyCarCheck' : langue === 'en' ? 'About EasyCarCheck' : 'À propos d\'EasyCarCheck'}</div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        <div style="background:rgba(255,255,255,0.08); border-radius:8px; padding:12px;">
          <div style="font-size:10px; color:#00B4D8; font-weight:700; margin-bottom:4px;">${langue === 'de' ? 'KI-Analyse' : langue === 'it' ? 'Analisi IA' : langue === 'en' ? 'AI Analysis' : 'Analyse IA'}</div>
          <div style="font-size:10px; color:#b8d0f0; line-height:1.5;">${langue === 'de' ? 'GPT-4o analysiert Preis, Zuverlässigkeit und Wartungskosten anhand realer Marktdaten.' : langue === 'it' ? 'GPT-4o analizza prezzo, affidabilità e costi di manutenzione con dati reali di mercato.' : langue === 'en' ? 'GPT-4o analyzes price, reliability and maintenance costs based on real market data.' : 'GPT-4o analyse le prix, la fiabilité et les coûts d\'entretien à partir de données réelles du marché.'}</div>
        </div>
        <div style="background:rgba(255,255,255,0.08); border-radius:8px; padding:12px;">
          <div style="font-size:10px; color:#00B4D8; font-weight:700; margin-bottom:4px;">${langue === 'de' ? 'Schweizer Markt' : langue === 'it' ? 'Mercato Svizzero' : langue === 'en' ? 'Swiss Market' : 'Marché Suisse'}</div>
          <div style="font-size:10px; color:#b8d0f0; line-height:1.5;">${langue === 'de' ? 'Preise und Kosten sind auf den Schweizer Markt ' + new Date().getFullYear() + ' kalibriert (CHF, Steuern, Versicherung).' : langue === 'it' ? 'Prezzi e costi calibrati sul mercato svizzero ' + new Date().getFullYear() + ' (CHF, tasse, assicurazione).' : langue === 'en' ? 'Prices and costs calibrated for the ' + new Date().getFullYear() + ' Swiss market (CHF, taxes, insurance).' : 'Prix et coûts calibrés pour le marché suisse ' + new Date().getFullYear() + ' (CHF, taxes, assurance).'}</div>
        </div>
        <div style="background:rgba(255,255,255,0.08); border-radius:8px; padding:12px;">
          <div style="font-size:10px; color:#00B4D8; font-weight:700; margin-bottom:4px;">${langue === 'de' ? 'Sofortbericht' : langue === 'it' ? 'Rapporto Immediato' : langue === 'en' ? 'Instant Report' : 'Rapport Immédiat'}</div>
          <div style="font-size:10px; color:#b8d0f0; line-height:1.5;">${langue === 'de' ? 'Analyse in unter 60 Sekunden. Kein Warten, keine Terminvereinbarung.' : langue === 'it' ? 'Analisi in meno di 60 secondi. Nessuna attesa, nessun appuntamento.' : langue === 'en' ? 'Analysis in under 60 seconds. No waiting, no appointment.' : 'Analyse en moins de 60 secondes. Pas d\'attente, pas de rendez-vous.'}</div>
        </div>
        <div style="background:rgba(255,255,255,0.08); border-radius:8px; padding:12px;">
          <div style="font-size:10px; color:#00B4D8; font-weight:700; margin-bottom:4px;">${langue === 'de' ? 'Unabhängig' : langue === 'it' ? 'Indipendente' : langue === 'en' ? 'Independent' : 'Indépendant'}</div>
          <div style="font-size:10px; color:#b8d0f0; line-height:1.5;">${langue === 'de' ? 'Keine Verbindung zu Händlern. Nur Ihr Interesse zählt.' : langue === 'it' ? 'Nessun legame con concessionari. Solo il tuo interesse conta.' : langue === 'en' ? 'No ties to dealers. Only your interest matters.' : 'Aucun lien avec les vendeurs. Seul votre intérêt compte.'}</div>
        </div>
      </div>
    </div>

    <div class="footer" style="margin-top:12px;">
      Source : ${url}<br>
      ${L.disclaimer}<br>
      EasyCarCheck · easycarcheck.ch · contact@easycarcheck.ch · Suisse
    </div>
  </div>

</body>
</html>`;

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    const pdfBuffer = await page.pdf({
      printBackground: true,
      width: '794px',
      height: await page.evaluate(() => document.body.scrollHeight + 'px'),
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' },
      pageRanges: '1'
    });
    return pdfBuffer;
  } finally {
    await browser.close();
  }
}

// ─── ENVOI EMAIL ─────────────────────────────────────────
async function envoyerEmail(email, pdfBuffer, analyse, reportNumber, langue = 'fr') {
  const verdictEmailColor = analyse.verdict === 'ACHETER' || analyse.verdict === 'KAUFEN' || analyse.verdict === 'BUY' || analyse.verdict === 'ACQUISTARE' ? '#28a745' : analyse.verdict === 'ÉVITER' || analyse.verdict === 'MEIDEN' || analyse.verdict === 'AVOID' || analyse.verdict === 'EVITARE' ? '#dc3545' : '#d4a00a';
  const scoreEmailColor = analyse.score_global >= 7 ? '#28a745' : analyse.score_global >= 5 ? '#d4a00a' : '#dc3545';

  const result = await resend.emails.send({
    from: 'EasyCarCheck <contact@easycarcheck.ch>',
    to: email,
    subject: `${langue === 'de' ? '● Ihr EasyCarCheck-Bericht' : langue === 'it' ? '● Il tuo rapporto EasyCarCheck' : langue === 'en' ? '● Your EasyCarCheck Report' : '● Votre rapport EasyCarCheck'} #${reportNumber} — ${analyse.marque} ${analyse.modele}`,
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f0f6ff;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f6ff;padding:30px 20px;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

  <tr><td style="background:#1a3a6e;border-radius:12px 12px 0 0;padding:24px;text-align:center;">
    <div style="font-size:22px;font-weight:700;color:#fff;letter-spacing:1px;">&#9658; EASY<span style="color:#00B4D8;">CAR</span>CHECK</div>
    <div style="font-size:12px;color:#b8d0f0;margin-top:4px;">${langue === "de" ? "KI-Analyse · Schweizer Markt" : langue === "it" ? "Analisi IA · Mercato Svizzero" : langue === "en" ? "AI Analysis · Swiss Market" : "Analyse IA · Marché Suisse"}</div>
  </td></tr>

  <tr><td style="background:#fff;padding:32px 28px;border-left:1px solid #d0e4f7;border-right:1px solid #d0e4f7;">

    <div style="text-align:center;margin-bottom:28px;">
      <div style="width:56px;height:56px;background:rgba(40,167,69,0.1);border:2px solid #28a745;border-radius:50%;margin:0 auto 14px;line-height:56px;font-size:26px;text-align:center;">✅</div>
      <h1 style="font-size:22px;font-weight:900;color:#0d1b35;margin:0 0 6px;">${langue === "de" ? "Ihr Bericht ist bereit!" : langue === "it" ? "Il tuo rapporto è pronto!" : langue === "en" ? "Your report is ready!" : "Votre rapport est prêt !"}</h1>
      <p style="font-size:14px;color:#5a7a9a;margin:0;">${langue === "de" ? "Er ist als PDF-Anhang an diese E-Mail angehängt." : langue === "it" ? "È allegato a questa email in formato PDF." : langue === "en" ? "It is attached to this email as a PDF." : "Il est joint à cet email en pièce jointe PDF."}</p>
    </div>

    <div style="background:#f0f6ff;border-radius:10px;padding:18px 20px;margin-bottom:24px;border:1px solid #d0e4f7;">
      <div style="font-size:11px;color:#5a7a9a;letter-spacing:1px;margin-bottom:10px;">${langue === "de" ? "IHRE ANALYSE" : langue === "it" ? "LA TUA ANALISI" : langue === "en" ? "YOUR ANALYSIS" : "VOTRE ANALYSE"}</div>
      <div style="font-size:18px;font-weight:900;color:#0d1b35;margin-bottom:12px;">${analyse.marque?.toUpperCase()} ${analyse.modele?.toUpperCase()}</div>
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td width="33%" style="padding-right:6px;">
            <div style="background:#fff;border-radius:8px;padding:10px;text-align:center;border:1px solid #d0e4f7;">
              <div style="font-size:9px;color:#5a7a9a;letter-spacing:1px;margin-bottom:4px;">SCORE</div>
              <div style="font-size:22px;font-weight:900;color:${scoreEmailColor};">${analyse.score_global}/10</div>
            </div>
          </td>
          <td width="33%" style="padding:0 3px;">
            <div style="background:#fff;border-radius:8px;padding:10px;text-align:center;border:1px solid #d0e4f7;">
              <div style="font-size:9px;color:#5a7a9a;letter-spacing:1px;margin-bottom:4px;">VERDICT</div>
              <div style="font-size:14px;font-weight:900;color:${verdictEmailColor};">${traduireVerdict(analyse.verdict, langue)}</div>
            </div>
          </td>
          <td width="33%" style="padding-left:6px;">
            <div style="background:#fff;border-radius:8px;padding:10px;text-align:center;border:1px solid #d0e4f7;">
              <div style="font-size:9px;color:#5a7a9a;letter-spacing:1px;margin-bottom:4px;">${langue === "de" ? "BERICHT" : langue === "it" ? "RAPPORTO" : langue === "en" ? "REPORT" : "RAPPORT"}</div>
              <div style="font-size:16px;font-weight:900;color:#1a3a6e;">#${reportNumber}</div>
            </div>
          </td>
        </tr>
      </table>
    </div>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr><td style="padding:12px 0;border-bottom:1px solid #f0f6ff;">
        <table><tr>
          <td style="font-size:18px;padding-right:12px;">📄</td>
          <td>
            <div style="font-size:13px;font-weight:700;color:#0d1b35;">${langue === "de" ? "PDF-Bericht im Anhang" : langue === "it" ? "Rapporto PDF in allegato" : langue === "en" ? "PDF Report attached" : "Rapport PDF en pièce jointe"}</div>
            <div style="font-size:12px;color:#5a7a9a;">EasyCarCheck_Rapport_${reportNumber}.pdf</div>
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:12px 0;border-bottom:1px solid #f0f6ff;">
        <table><tr>
          <td style="font-size:18px;padding-right:12px;">🔍</td>
          <td>
            <div style="font-size:13px;font-weight:700;color:#0d1b35;">${langue === "de" ? "Red Flags, Besichtigungs-Checkliste, Verhandlungspreis" : langue === "it" ? "Red flags, checklist visita, prezzo di trattativa" : langue === "en" ? "Red flags, visit checklist, negotiation price" : "Red flags, checklist visite, prix de négociation"}</div>
            <div style="font-size:12px;color:#5a7a9a;">${langue === "de" ? "Alles im beigefügten PDF-Bericht" : langue === "it" ? "Tutto nel rapporto PDF allegato" : langue === "en" ? "Everything is in the attached PDF report" : "Tout est dans le rapport PDF joint"}</div>
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:12px 0;">
        <table><tr>
          <td style="font-size:18px;padding-right:12px;">⚠️</td>
          <td>
            <div style="font-size:13px;font-weight:700;color:#0d1b35;">Rapport non reçu ?</div>
            <div style="font-size:12px;color:#5a7a9a;">Vérifiez vos spams · <a href="mailto:contact@easycarcheck.ch" style="color:#1a3a6e;">contact@easycarcheck.ch</a></div>
          </td>
        </tr></table>
      </td></tr>
    </table>

    <div style="background:#f0f6ff;border-radius:10px;padding:16px;border:1px solid #d0e4f7;text-align:center;">
      <p style="font-size:13px;color:#5a7a9a;margin:0;line-height:1.6;">${langue === "de" ? "Dieser Bericht ist ein Entscheidungshilfe-Tool.<br>Er ersetzt keine physische Inspektion durch einen Fachmann." : langue === "it" ? "Questo rapporto è uno strumento di supporto decisionale.<br>Non sostituisce un'ispezione fisica da parte di un professionista." : langue === "en" ? "This report is a decision-support tool.<br>It does not replace a physical inspection by a professional." : "Ce rapport est un outil d'aide à la décision.<br>Il ne remplace pas une inspection physique par un professionnel."}</p>
    </div>

  </td></tr>

  <tr><td style="background:#1a3a6e;border-radius:0 0 12px 12px;padding:20px;text-align:center;">
    <div style="font-size:12px;color:#b8d0f0;margin-bottom:8px;">EasyCarCheck · easycarcheck.ch ·  Suisse</div>
    <div>
      <a href="https://easycarcheck.ch" style="font-size:11px;color:#8fa8c8;text-decoration:none;margin:0 8px;">Site web</a>
      <a href="https://easycarcheck.ch/mentions-legales.html" style="font-size:11px;color:#8fa8c8;text-decoration:none;margin:0 8px;">Mentions légales</a>
      <a href="mailto:contact@easycarcheck.ch" style="font-size:11px;color:#8fa8c8;text-decoration:none;margin:0 8px;">Contact</a>
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>
    `,
    attachments: [{
      filename: `EasyCarCheck_Rapport_${reportNumber}.pdf`,
      content: pdfBuffer.toString('base64')
    }]
  });
  console.log('RESEND RESULT:', JSON.stringify(result));
}

// ─── ROUTES ──────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'EasyCarCheck Backend OK ●' }));

// Diagnostic : renvoie des extraits de la page de résultats AutoScout24 pour vérifier où se trouvent km/prix/année
app.post('/admin/debug-recherche', exigerCleAdmin, async (req, res) => {
  try {
    const url = (req.body && req.body.url) || 'https://www.autoscout24.ch/fr/s/mo-rs3/mk-audi?firstRegistrationYearFrom=2022&firstRegistrationYearTo=2024';
    const r = await axios.get('https://api.zenrows.com/v1/', {
      params: { apikey: process.env.ZENROWS_API_KEY, url, js_render: 'true', premium_proxy: 'true', wait: '6000' }, timeout: 120000
    });
    const html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
    const autour = (re, n = 2, l = 500) => [...html.matchAll(re)].slice(0, n).map(m => html.substring(Math.max(0, m.index - l), m.index + l).replace(/\s+/g, ' '));
    res.json({
      taille: html.length,
      liensAnnonces: (html.match(/\/(?:fr|de|it|en)\/d\/[a-z0-9-]+-\d{6,}/gi) || []).length,
      mileage: (html.match(/mileage/g) || []).length,
      nextData: html.includes('__NEXT_DATA__'),
      nextF: html.includes('self.__next_f'),
      extraitsMileage: autour(/mileage/g),
      extraitsLien: autour(/\/fr\/d\/[a-z0-9-]+-\d{6,}/gi, 1, 800)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Vider la mémoire (tout, ou seulement les entrées qui contiennent un mot, ex : {"filtre":"rs3"})
app.post('/admin/vider-cache', exigerCleAdmin, (req, res) => {
  const filtre = String((req.body && req.body.filtre) || '').toLowerCase();
  let n = 0;
  for (const type of ['fiabilite', 'marche']) {
    for (const cle of Object.keys(cache[type])) {
      if (!filtre || cle.includes(filtre)) { delete cache[type][cle]; n++; }
    }
  }
  sauverCache();
  res.json({ supprimees: n });
});

app.post('/test-rapport', exigerCleAdmin, async (req, res) => {
  try {
    const { url, email, langue = 'fr' } = req.body;
    if (!url || !email) return res.status(400).json({ error: 'URL et email requis' });
    console.log('1. Démarrage analyse...');
    const reportNumber = String(Math.floor(Math.random() * 900) + 100).padStart(3, '0');
    const analyse = await obtenirAnalyse(url, langue, { forcer: true });
    console.log('2. Analyse OK');
    console.log('3. GPT OK - Verdict:', analyse.verdict, '| Score:', analyse.score_global, '| CO2:', analyse.co2, '| Taxe:', analyse.taxe_cantonale_ge);
    const pdf = await genererPDF(analyse, reportNumber, url, langue);
    console.log('4. PDF OK');
    await envoyerEmail(email, pdf, analyse, reportNumber, langue);
    console.log('5. Email envoyé !');
    res.json({ success: true, reportNumber, verdict: analyse.verdict, score: analyse.score_global });
  } catch (err) {
    console.error('ERREUR:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── ANALYSES RÉCENTES : l'aperçu gratuit et le rapport payé donnent EXACTEMENT le même résultat ───
// (le client voit le même score/verdict avant et après paiement, et on ne paie pas deux fois l'analyse)
const analysesRecentes = new Map();
const DUREE_ANALYSE = 24 * 3600 * 1000;
async function obtenirAnalyse(url, langue, { forcer = false } = {}) {
  const cle = `${url.split('?')[0]}|${langue}`;
  const memo = analysesRecentes.get(cle);
  if (!forcer && memo && Date.now() - memo.ts < DUREE_ANALYSE) {
    console.log('ANALYSE réutilisée (moins de 24 h) :', cle);
    return memo.analyse;
  }
  const scraped = await scrapeAnnonce(url, langue);
  const analyse = await analyserAvecGPT(scraped, langue, url);
  analysesRecentes.set(cle, { ts: Date.now(), analyse });
  if (analysesRecentes.size > 500) analysesRecentes.delete(analysesRecentes.keys().next().value);
  return analyse;
}

// ─── APERÇU GRATUIT (utilisé par le site) : ouvert au public mais limité pour protéger le budget ───
const LIMITE_GRATUIT_IP = parseInt(process.env.FREE_PER_IP_PER_DAY) || 3;   // par visiteur et par jour
const LIMITE_GRATUIT_JOUR = parseInt(process.env.FREE_PER_DAY) || 150;      // pour tout le site et par jour
const compteurGratuit = { jour: '', total: 0, parIp: new Map() };
function verifierLimiteGratuit(req) {
  if (process.env.ADMIN_KEY && req.headers['x-admin-key'] === process.env.ADMIN_KEY) return null;
  const jour = new Date().toISOString().slice(0, 10);
  if (compteurGratuit.jour !== jour) { compteurGratuit.jour = jour; compteurGratuit.total = 0; compteurGratuit.parIp.clear(); }
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const n = compteurGratuit.parIp.get(ip) || 0;
  if (n >= LIMITE_GRATUIT_IP) return 'Limite d\'analyses gratuites atteinte pour aujourd\'hui. Réessayez demain ou commandez le rapport complet.';
  if (compteurGratuit.total >= LIMITE_GRATUIT_JOUR) return 'Le service d\'aperçu gratuit est très demandé aujourd\'hui. Réessayez plus tard ou commandez le rapport complet.';
  compteurGratuit.parIp.set(ip, n + 1);
  compteurGratuit.total++;
  return null;
}
// Sites d'annonces acceptés (ceux annoncés sur easycarcheck.ch)
const urlAnnonceValide = (u) => /^https?:\/\/([a-z0-9-]+\.)*(autoscout24\.ch|ricardo\.ch|tutti\.ch|anibis\.ch)\/\S+$/i.test(String(u || '').trim());

app.post('/analyse-gratuite', async (req, res) => {
  try {
    const { url, langue = 'fr' } = req.body || {};
    console.log('APERÇU GRATUIT demandé :', url, '| langue :', langue);
    if (!url) return res.status(400).json({ error: 'URL manquante' });
    if (!urlAnnonceValide(url)) { console.log('APERÇU GRATUIT refusé : lien non reconnu'); return res.status(400).json({ error: 'Merci de coller le lien d\'une annonce AutoScout24, Ricardo, Tutti ou Anibis.' }); }
    const refus = verifierLimiteGratuit(req);
    if (refus) { console.log('APERÇU GRATUIT refusé : limite atteinte'); return res.status(429).json({ error: refus }); }
    const analyse = await obtenirAnalyse(url.trim(), langue);
    res.json({
      marque: analyse.marque, modele: analyse.modele, annee: analyse.annee,
      prix: analyse.prix, score_global: analyse.score_global, verdict: analyse.verdict,
      // Détails publics de l'annonce (déjà visibles sur AutoScout24) pour enrichir l'aperçu
      kilometrage: analyse.kilometrage, puissance: analyse.puissance, couleur: analyse.couleur,
      carburant: analyse.carburant, boite: analyse.boite, transmission: analyse.transmission,
      teaser: true
    });
  } catch (err) {
    console.error('APERÇU GRATUIT erreur :', err.message);
    res.status(500).json({ error: 'Analyse impossible pour cette annonce. Vérifiez le lien et réessayez.' });
  }
});

app.post('/create-checkout', async (req, res) => {
  try {
    const { url, email, langue = 'fr', pack = 'single' } = req.body;
    const prices = { single: 900, pack3: 2700, pack5: 4000 };
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'chf',
          product_data: {
            name: pack === 'single' ? 'Rapport EasyCarCheck' : `Pack ${pack === 'pack3' ? '3' : '5'} rapports EasyCarCheck`,
            description: 'Analyse IA spécialisée marché suisse'
          },
          unit_amount: prices[pack] || 900
        },
        quantity: 1
      }],
      mode: 'payment',
      success_url: `https://easycarcheck.ch/merci.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `https://easycarcheck.ch`,
      metadata: { url, email, langue, pack }
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Sessions déjà traitées (évite d'envoyer 2 rapports si Stripe renvoie le même événement)
const sessionsTraitees = new Set();

async function traiterCommande(session) {
  const { url, email, langue = 'fr' } = session.metadata || {};
  try {
    const reportNumber = String(Math.floor(Math.random() * 900) + 100).padStart(3, '0');
    const analyse = await obtenirAnalyse(url, langue);
    const pdf = await genererPDF(analyse, reportNumber, url, langue);
    await envoyerEmail(email, pdf, analyse, reportNumber, langue);
    console.log(`✅ Rapport #${reportNumber} envoyé à ${email}`);
  } catch (err) {
    console.error('❌ Erreur génération rapport payé:', err);
    // Alerte : un client a payé mais n'a pas reçu son rapport
    try {
      await resend.emails.send({
        from: 'EasyCarCheck <contact@easycarcheck.ch>',
        to: process.env.ADMIN_EMAIL || 'contact@easycarcheck.ch',
        subject: `⚠️ Rapport payé NON envoyé — ${email}`,
        html: `<p>Un client a payé mais le rapport a échoué.</p>
               <p><b>Client :</b> ${email}<br><b>Annonce :</b> ${url}<br><b>Langue :</b> ${langue}<br>
               <b>Session Stripe :</b> ${session.id}<br><b>Erreur :</b> ${err.message}</p>
               <p>À faire : relancer le rapport manuellement ou rembourser le client.</p>`
      });
    } catch (e) {
      console.error('Alerte admin impossible:', e.message);
    }
  }
}

app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature invalide:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Répondre IMMÉDIATEMENT à Stripe : sinon il considère l'envoi comme raté
  // (le rapport prend ~60 s) et renvoie l'événement → risque de doublons.
  res.json({ received: true });

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (sessionsTraitees.has(session.id)) {
      console.log('Session déjà traitée, ignorée:', session.id);
      return;
    }
    sessionsTraitees.add(session.id);
    traiterCommande(session); // tourne en arrière-plan
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`● EasyCarCheck Backend running on port ${PORT}`));
