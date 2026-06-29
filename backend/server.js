require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

// ─── MOIS TRADUIT ────────────────────────────────────────
function getMoisRapport(langue) {
  const now = new Date();
  const mois = {
    fr: ['JANVIER','FÉVRIER','MARS','AVRIL','MAI','JUIN','JUILLET','AOÛT','SEPTEMBRE','OCTOBRE','NOVEMBRE','DÉCEMBRE'],
    de: ['JANUAR','FEBRUAR','MÄRZ','APRIL','MAI','JUNI','JULI','AUGUST','SEPTEMBER','OKTOBER','NOVEMBER','DEZEMBER'],
    it: ['GENNAIO','FEBBRAIO','MARZO','APRILE','MAGGIO','GIUGNO','LUGLIO','AGOSTO','SETTEMBRE','OTTOBRE','NOVEMBRE','DICEMBRE'],
    en: ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER']
  };
  const m = mois[langue] || mois.fr;
  return `${m[now.getMonth()]} ${now.getFullYear()}`;
}

// ─── SCRAPING ───────────────────────────────────────────
async function scrapeAnnonce(url, langue = 'fr') {
  const langMap = { fr: 'fr', de: 'de', it: 'it', en: 'en' };
  const targetLang = langMap[langue] || 'fr';
  url = url.replace(/autoscout24\.ch\/(fr|de|it|en)\//, `autoscout24.ch/${targetLang}/`);
  try {
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

    // Appel CSS extractor pour les équipements
    let cssEquipments = [];
    try {
      const cssResponse = await axios.get('https://api.zenrows.com/v1/', {
        params: {
          apikey: process.env.ZENROWS_API_KEY,
          url: url,
          js_render: 'true',
          premium_proxy: 'true',
          wait: '8000',
          css_extractor: JSON.stringify({ equipments: '#expandable-equipment li.chakra-list__item' })
        },
        timeout: 120000
      });
      const cssData = cssResponse.data;
      if (cssData && cssData.equipments && Array.isArray(cssData.equipments)) {
        setLangue(langue || 'fr');
        cssEquipments = cssData.equipments.filter(e => e && e.trim().length > 2);
        console.log('CSS EXTRACTOR équipements:', cssEquipments.length);
      }
    } catch(e) {
      console.log('CSS extractor erreur:', e.message);
    }

    let equipmentData = '';
    let co2Value = null;
    let optionsList = [];

    try {
      // MÉTHODE 1: JSON échappé
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

      // MÉTHODE 2: <li class="chakra-list__item">
      if (optionsList.length === 0) {
        const liMatches = [...html.matchAll(/<li class="chakra-list__item">([^<]+)<\/li>/g)];
        const liNames = liMatches.map(m => m[1].trim()).filter(n => n.length > 2);
        if (liNames.length > 0) {
          optionsList = [...new Set(liNames)];
          equipmentData += "\nOPTIONS_LI (" + optionsList.length + "): " + optionsList.join(" | ");
        }
      }

      // MÉTHODE 3: JSON non-échappé
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

      // MÉTHODE 4: searchAttributes
      const saSection = html.match(/(?:\\"searchAttributes\\":|"searchAttributes":)\s*\[([^\]]{10,}?)\]/);
      if (saSection) {
        const saItems = [...saSection[1].matchAll(/(?:\\"|")([^"\\]+)(?:\\"|")/g)].map(m => m[1]);
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
        };
        const saNames = saItems.map(k => saDict[k]).filter(v => v);
        if (saNames.length > 0) {
          optionsList = [...new Set([...optionsList, ...saNames])];
          equipmentData += "\nSEARCH_ATTR (" + saNames.length + "): " + saNames.join(" | ");
          console.log("SEARCH_ATTR extraits:", saNames.length);
        }
      }

      // MÉTHODE 5: CSS Extractor ZenRows
      if (cssEquipments.length > 0) {
        const cssTranslated = cssEquipments.map(e => traduireOption(e)).filter(e => e !== null);
        optionsList = [...new Set([...cssTranslated, ...optionsList])];
        console.log("CSS_EXTRACTOR fusionné:", cssTranslated.length, "options");
      }

      console.log("OPTIONS EXTRAITES:", optionsList.length);

      // CO2
      const co2Match = html.match(/"emissionsCO2":"(\d+)\s*g\/km"/) ||
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

      console.log("CO2 EXTRAIT:", co2Value);
    } catch(e) {
      console.log("Extraction JSON echouee:", e.message);
    }

    let cleanHtml = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    cleanHtml = cleanHtml.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    cleanHtml = cleanHtml.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, "");
    cleanHtml = cleanHtml.replace(/<[^>]+>/g, " ");
    cleanHtml = cleanHtml.replace(/\s+/g, " ").trim();

    const finalContent = cleanHtml.substring(0, 35000);
    console.log("ZENROWS OK:", finalContent.substring(0, 500));

    return { html: finalContent, url: url, equipmentData: equipmentData, co2: co2Value, options: optionsList };
  } catch (err) {
    console.log('ZENROWS ERROR:', err.response?.data || err.message);
    return { html: `URL: ${url}`, url: url, equipmentData: '', co2: null, options: [] };
  }
}

// ─── ESTIMATION TAXE ────────────────────────────────────
function estimerTaxe(co2, carburant) {
  if (!carburant) return 600;
  const isElectric = carburant.toLowerCase().includes('électr') || carburant.toLowerCase().includes('elektr') || carburant.toLowerCase().includes('electr');
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

// ─── DICTIONNAIRE OPTIONS MULTILINGUE ───────────────────
const OPTIONS_DICT = {
  'Details siehe Preisliste': null,
  'Détails consultez la liste de prix': null,
  'Keine Gewähr auf die Angaben der Serienausstattungen': null,
  'Aucune garantie sur l exactitude de l équipement de série': null,
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
  'Éclairage d ambiance':          { fr: "Éclairage d'ambiance", de: "Ambientebeleuchtung", it: "Illuminazione ambientale", en: "Ambient lighting" },
  'Éclairage d\'ambiance intérieur': { fr: "Éclairage d'ambiance", de: "Ambientebeleuchtung", it: "Illuminazione ambientale", en: "Ambient lighting" },
  'Aileron arrière':               { fr: "Aileron arrière AMG", de: "AMG Heckspoiler", it: "Spoiler posteriore AMG", en: "AMG rear spoiler" },
  'Gilets de sécurité pour le conducteur et les passagers': { fr: "Ceintures de sécurité", de: "Sicherheitsgurte", it: "Cinture di sicurezza", en: "Seat belts" },
  'Intérieur MBUX Assist':         { fr: "Système MBUX", de: "MBUX System", it: "Sistema MBUX", en: "MBUX System" },
  'Distronic/ tempomat à réglage de distance': { fr: "Régulateur de distance adaptatif", de: "Distronic Abstandsregeltempomat", it: "Cruise control adattivo", en: "Adaptive cruise control" },
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

// ─── ANALYSE GPT-4o ─────────────────────────────────────
async function analyserAvecGPT(scrapedData, langue, url) {
  const langues = { fr: 'français', de: 'allemand', it: 'italien', en: 'anglais' };
  const equipmentSection = scrapedData.equipmentData
    ? `\n\nDONNÉES STRUCTURÉES EXTRAITES (priorité sur le texte brut) :\n${scrapedData.equipmentData}`
    : '';

  const prompt = `LANGUE OBLIGATOIRE : ${langues[langue] || 'français'}
IMPORTANT : Tu dois rédiger ABSOLUMENT TOUT le rapport en ${langues[langue] || 'français'}. Chaque mot, chaque phrase, chaque champ JSON doit être en ${langues[langue] || 'français'}. PAS DE MÉLANGE DE LANGUES.

Tu es un expert en analyse de véhicules d'occasion sur le marché suisse.

Voici le contenu de l'annonce automobile :
URL: ${url}
Contenu: ${scrapedData.html}${equipmentSection}

ÉTAPE 1 - Extrais ces données EXACTES depuis le contenu :
- Prix exact en CHF (nombre entier)
- Kilométrage exact (nombre entier)
- Année exacte
- Marque et modèle exacts
- Carburant (Essence / Diesel / Électrique / Hybride)
- Boîte de vitesses
- Puissance en PS uniquement (ex: "306 PS")
- CO2 en g/km : utilise la valeur de la section "DONNÉES STRUCTURÉES" si disponible (nombre entier, sinon null)
- Couleur exacte — cherche PARTOUT dans la page (titre, description, caractéristiques). Si introuvable, mets "Non communiquée"
- Transmission (2 roues motrices / 4 roues motrices)
- Description complète du vendeur
- TOUTES les options et équipements listés — utilise la liste de la section "DONNÉES STRUCTURÉES" ci-dessus en priorité (elle est complète), supprimer les doublons, traduire tout en ${langues[langue] || 'français'}, supprimer les mentions "Détails consultez la liste de prix" et "Details siehe Preisliste"

ÉTAPE 2 - Analyse approfondie :
- Compare le prix avec le marché suisse actuel et calcule fourchette marché min et max réaliste
- Pour Mercedes A35 AMG : problème culasse moteur M260 récurrent (remplacement 5000-8000 CHF hors garantie), boîte DCT fragile
- Pour Audi RS6 C7 (2013-2018) moteur 4.0 TFSI : consommation d'huile à surveiller (risque rupture de bielle lié au launch control), suspension pneumatique coûteuse (2000-4000 CHF), courroie de distribution à vérifier vers 100000 km, budget entretien 3000-6000 CHF/an
- Pour TOUTES les voitures : utilise ta connaissance des problèmes récurrents documentés du modèle spécifique
- problemes_connus_modele : TOUJOURS 2 problèmes RÉELS et SPÉCIFIQUES au modèle exact
- questions_vendeur : adapter les questions au modèle
- CULASSE : Si "Zylinderkopf", "culasse", "cylindre" mentionné → ajouter EXACTEMENT "Culasse remplacée" dans red_flags ET points_negatifs
- Si culasse remplacée → baisser score_fiabilite de 2 points et score_global de 1 point
- INTERDITS comme points négatifs : "consommation de carburant élevée", "consommation d'huile élevée", "kilométrage élevé", "kilométrage relativement élevé", "kilométrage important", "consommation élevée"
- KILOMÉTRAGE : NE JAMAIS mentionner le kilométrage comme point négatif
- SPORTIVES (RS, AMG, M, S, R): Ne pas mentionner la consommation comme point négatif
- FREE SERVICE Mercedes : cout_entretien_annee1 = 250, cout_total_3ans = 750. Mentionner dans points_positifs "Entretien main d'oeuvre et pièces couvert par Mercedes (liquides à la charge du propriétaire)"
- Sans free service : estimer les coûts selon le modèle
  * Voiture compacte / citadine : 400-600 CHF/an
  * Berline / break standard : 800-1200 CHF/an
  * SUV / 4x4 standard : 1000-1500 CHF/an
  * Voiture sportive / premium : 2000-3000 CHF/an
  * Voiture ultra-sportive : 3000-5000 CHF/an
- BOÎTE : "Manuelle robotisée" = "Automatique (DCT)" pour Mercedes AMG
- DESCRIPTION VENDEUR : Traduire INTÉGRALEMENT en ${langues[langue] || 'français'}
- score_global = mettre 0 (calculé automatiquement)
- taxe_cantonale_ge = mettre 0 (calculé automatiquement)
- score_prix, score_fiabilite, score_entretien : OBLIGATOIRE entre 1 et 10
- options : inclure TOUTES les options sans limiter

QUANTITÉS STRICTES :
- points_positifs : exactement 3 éléments en ${langues[langue] || 'français'}
- points_negatifs : exactement 3 éléments en ${langues[langue] || 'français'}
- checklist_visite : exactement 4 éléments
- questions_vendeur : exactement 3 questions
- problemes_connus_modele : exactement 2 éléments
- conseil_achat : 2-3 phrases de conseil personnalisé

RÈGLES JSON :
1. JSON valide uniquement, rien d'autre
2. verdict = "ACHETER", "NÉGOCIER" ou "ÉVITER"
3. Guillemets doubles uniquement
4. score_global = 0
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
  "score_global": 0,
  "verdict": "NÉGOCIER",
  "economie_potentielle_min": 0,
  "economie_potentielle_max": 0,
  "prix_negocie_suggere": 0,
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
}`;

  const response = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 4000
  }, {
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  const content = response.data.choices[0].message.content;
  let clean = content.replace(/```json|```/g, '').trim();
  console.log('GPT RESPONSE:', clean.substring(0, 500));

  let parsed;
  try {
    parsed = JSON.parse(clean);
  } catch(e) {
    clean = clean.replace(/,(\s*[}\]])/g, '$1').replace(/[\u2018\u2019]/g, '');
    try {
      parsed = JSON.parse(clean);
    } catch(e2) {
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch(e3) { throw new Error('JSON invalide'); }
      } else { throw new Error('JSON invalide'); }
    }
  }

  // CO2 scraping prioritaire
  if ((!parsed.co2 || parsed.co2 === 0) && scrapedData.co2) {
    parsed.co2 = scrapedData.co2;
    console.log('CO2 injecté depuis scraping:', parsed.co2);
  }

  // Force scores entiers
  parsed.score_prix = Math.max(1, Math.round(parsed.score_prix || 5));
  parsed.score_fiabilite = Math.max(1, Math.round(parsed.score_fiabilite || 5));
  parsed.score_entretien = Math.max(1, Math.round(parsed.score_entretien || 5));
  parsed.score_global = Math.round((parsed.score_prix + parsed.score_fiabilite + parsed.score_entretien) / 3);

  // Culasse détectée
  const culasseDetectee = (parsed.red_flags || []).some(r => r.toLowerCase().includes('culasse')) ||
    (parsed.points_negatifs || []).some(p => p.toLowerCase().includes('culasse'));
  if (culasseDetectee && parsed.score_fiabilite > 5) parsed.score_fiabilite = 5;
  if (culasseDetectee) {
    parsed.score_global = Math.round((parsed.score_prix + parsed.score_fiabilite + parsed.score_entretien) / 3);
  }

  // Calcul taxe
  let co2Final = scrapedData.co2 || parsed.co2;
  if (!co2Final && parsed.marque && parsed.modele) {
    const modeleStr = (parsed.marque + ' ' + parsed.modele).toLowerCase();
    if (modeleStr.includes('a 35 amg') || modeleStr.includes('a35 amg')) co2Final = 210;
    else if (modeleStr.includes('a 45 amg') || modeleStr.includes('a45 amg')) co2Final = 220;
    else if (modeleStr.includes('c 63 amg') || modeleStr.includes('c63')) co2Final = 250;
    else if (modeleStr.includes('amg')) co2Final = 200;
    console.log(`CO2 fallback modèle utilisé: ${co2Final} g/km`);
  }
  parsed.taxe_cantonale_ge = estimerTaxe(co2Final, parsed.carburant);
  console.log(`TAXE calculée: CO2=${co2Final} → ${parsed.taxe_cantonale_ge} CHF`);

  // Configurer la langue pour la traduction des options
  setLangue(langue || 'fr');

  // Injecter options depuis scraping
  if (scrapedData.options && scrapedData.options.length > 0) {
    parsed.options = scrapedData.options.map(o => traduireOption(o)).filter(o => o !== null);
    console.log('OPTIONS injectées depuis scraping:', parsed.options.length);
  } else if (parsed.options && parsed.options.length > 0) {
    parsed.options = parsed.options.map(o => traduireOption(o)).filter(o => o !== null);
    console.log('OPTIONS depuis GPT (fallback):', parsed.options.length);
  }

  parsed.puissance = nettoyerPuissance(parsed.puissance);

  // Filtrer points négatifs interdits
  const mots_interdits = ['kilométrage', 'kilometrage', 'consommation de carburant', 'consommation élevée', 'km élevé', 'km important'];
  if (parsed.points_negatifs) {
    parsed.points_negatifs = parsed.points_negatifs.filter(p =>
      !mots_interdits.some(mot => p.toLowerCase().includes(mot))
    );
  }

  // Traduction données brutes
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
    if (parsed.points_positifs) parsed.points_positifs = parsed.points_positifs.map(p => {
      for (const [fr, trad] of Object.entries(dt)) p = p.replace(new RegExp(fr, 'g'), trad);
      return p;
    });
  }

  // Traduction termes techniques
  const termesDict = {
    de: {
      'Culasse remplacée': 'Zylinderkopf ersetzt', 'Boîte DCT fragile': 'DCT-Getriebe anfällig',
      'Culasse': 'Zylinderkopf', 'culasse': 'Zylinderkopf', 'boîte DCT': 'DCT-Getriebe', 'Négocier': 'Verhandeln',
    },
    it: {
      'Culasse remplacée': 'Testata sostituita', 'Boîte DCT fragile': 'Cambio DCT fragile',
      'Culasse': 'Testata', 'culasse': 'testata',
    },
    en: {
      'Culasse remplacée': 'Cylinder head replaced', 'Boîte DCT fragile': 'DCT gearbox fragile',
      'Culasse': 'Cylinder head', 'culasse': 'cylinder head',
    }
  };

  const traduireTermes = (txt) => {
    if (!txt || !termesDict[langue]) return txt;
    let result = txt;
    for (const [fr, trad] of Object.entries(termesDict[langue] || {})) {
      result = result.replace(new RegExp(fr, 'g'), trad);
    }
    return result;
  };

  if (langue !== 'fr') {
    if (parsed.red_flags) parsed.red_flags = parsed.red_flags.map(traduireTermes);
    if (parsed.points_negatifs) parsed.points_negatifs = parsed.points_negatifs.map(traduireTermes);
    if (parsed.points_positifs) parsed.points_positifs = parsed.points_positifs.map(traduireTermes);
    if (parsed.verdict_texte) parsed.verdict_texte = traduireTermes(parsed.verdict_texte);
  }

  // Nettoyer mentions kilométrage dans textes
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
  if (parsed.conseil_achat) parsed.conseil_achat = nettoyerTexte(parsed.conseil_achat);
  if (parsed.verdict_texte) parsed.verdict_texte = nettoyerTexte(parsed.verdict_texte);

  if (parsed.points_positifs?.length > 3) parsed.points_positifs = parsed.points_positifs.slice(0, 3);
  if (parsed.points_negatifs?.length > 3) parsed.points_negatifs = parsed.points_negatifs.slice(0, 3);
  if (parsed.checklist_visite?.length > 4) parsed.checklist_visite = parsed.checklist_visite.slice(0, 4);
  if (parsed.questions_vendeur?.length > 3) parsed.questions_vendeur = parsed.questions_vendeur.slice(0, 3);
  if (parsed.problemes_connus_modele?.length > 2) parsed.problemes_connus_modele = parsed.problemes_connus_modele.slice(0, 2);

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
    fr: {
      marque: 'MARQUE & MODÈLE', score_global: 'SCORE GLOBAL', rapport: 'Rapport',
      prix: 'PRIX', fiabilite: 'FIABILITÉ', entretien: 'ENTRETIEN',
      annee: 'ANNÉE', km: 'KILOMÉTRAGE', prix_dem: 'PRIX DEMANDÉ',
      puissance: 'PUISSANCE', carburant: 'CARBURANT', boite: 'BOÎTE',
      transmission: 'TRANSMISSION', couleur: 'COULEUR', desc: 'DESCRIPTION VENDEUR',
      scores: 'DÉTAIL DES SCORES', points: 'POINTS CLÉS', options: 'ÉQUIPEMENTS & OPTIONS',
      couts: 'COÛTS & MARCHÉ', entretien1: 'ENTRETIEN AN 1', total3: 'TOTAL 3 ANS',
      co2: 'CO2 & TAXE CANTONALE', marche: 'FOURCHETTE MARCHÉ',
      taxe: 'Taxe: site officiel de votre canton',
      red: 'RED FLAGS', alerte: 'ALERTE', problemes: 'PROBLÈMES CONNUS DU MODÈLE',
      checklist: 'CHECKLIST VISITE', questions: 'QUESTIONS À POSER AU VENDEUR',
      conseil: "CONSEIL D'ACHAT", verdict: 'VERDICT FINAL',
      prix_suggere: 'PRIX SUGGÉRÉ', economie: '↓ Économie :',
      disclaimer: "Ce rapport est un outil d'aide à la décision. Il ne remplace pas une inspection physique par un professionnel.",
      co2_nr: 'Non renseigné'
    },
    de: {
      marque: 'MARKE & MODELL', score_global: 'GESAMTBEWERTUNG', rapport: 'Bericht',
      prix: 'PREIS', fiabilite: 'ZUVERLÄSSIGKEIT', entretien: 'WARTUNG',
      annee: 'JAHR', km: 'KILOMETERSTAND', prix_dem: 'VERLANGTER PREIS',
      puissance: 'LEISTUNG', carburant: 'KRAFTSTOFF', boite: 'GETRIEBE',
      transmission: 'ANTRIEB', couleur: 'FARBE', desc: 'VERKÄUFERBESCHREIBUNG',
      scores: 'BEWERTUNGSDETAILS', points: 'WICHTIGE PUNKTE', options: 'AUSSTATTUNG & OPTIONEN',
      couts: 'KOSTEN & MARKT', entretien1: 'WARTUNG JAHR 1', total3: 'TOTAL 3 JAHRE',
      co2: 'CO2 & KANTONSSTEUER', marche: 'MARKTPREISSPANNE',
      taxe: 'Steuer: offizielle Kantonswebsite',
      red: 'WARNHINWEISE', alerte: 'WARNUNG', problemes: 'BEKANNTE MODELLPROBLEME',
      checklist: 'BESICHTIGUNGS-CHECKLISTE', questions: 'FRAGEN AN DEN VERKÄUFER',
      conseil: 'KAUFEMPFEHLUNG', verdict: 'ENDURTEIL',
      prix_suggere: 'EMPF. PREIS', economie: '↓ Ersparnis :',
      disclaimer: 'Dieser Bericht ist ein Entscheidungshilfe-Tool. Er ersetzt keine physische Inspektion durch einen Fachmann.',
      co2_nr: 'Nicht angegeben'
    },
    it: {
      marque: 'MARCA & MODELLO', score_global: 'PUNTEGGIO GLOBALE', rapport: 'Rapporto',
      prix: 'PREZZO', fiabilite: 'AFFIDABILITÀ', entretien: 'MANUTENZIONE',
      annee: 'ANNO', km: 'CHILOMETRAGGIO', prix_dem: 'PREZZO RICHIESTO',
      puissance: 'POTENZA', carburant: 'CARBURANTE', boite: 'CAMBIO',
      transmission: 'TRAZIONE', couleur: 'COLORE', desc: 'DESCRIZIONE VENDITORE',
      scores: 'DETTAGLIO PUNTEGGI', points: 'PUNTI CHIAVE', options: 'EQUIPAGGIAMENTI & OPZIONI',
      couts: 'COSTI & MERCATO', entretien1: 'MANUTENZIONE ANNO 1', total3: 'TOTALE 3 ANNI',
      co2: 'CO2 & TASSA CANTONALE', marche: 'FASCIA DI MERCATO',
      taxe: 'Calcola sul sito ufficiale del tuo cantone',
      red: 'SEGNALAZIONI', alerte: 'ATTENZIONE', problemes: 'PROBLEMI NOTI DEL MODELLO',
      checklist: 'CHECKLIST VISITA', questions: 'DOMANDE AL VENDITORE',
      conseil: "CONSIGLIO D'ACQUISTO", verdict: 'VERDETTO FINALE',
      prix_suggere: 'PREZZO SUGGERITO', economie: '↓ Risparmio :',
      disclaimer: 'Questo rapporto è uno strumento di supporto decisionale. Non sostituisce un\'ispezione fisica da parte di un professionista.',
      co2_nr: 'Non indicato'
    },
    en: {
      marque: 'MAKE & MODEL', score_global: 'OVERALL SCORE', rapport: 'Report',
      prix: 'PRICE', fiabilite: 'RELIABILITY', entretien: 'MAINTENANCE',
      annee: 'YEAR', km: 'MILEAGE', prix_dem: 'ASKING PRICE',
      puissance: 'POWER', carburant: 'FUEL', boite: 'GEARBOX',
      transmission: 'DRIVE', couleur: 'COLOUR', desc: 'SELLER DESCRIPTION',
      scores: 'SCORE DETAILS', points: 'KEY POINTS', options: 'EQUIPMENT & OPTIONS',
      couts: 'COSTS & MARKET', entretien1: 'MAINTENANCE YEAR 1', total3: 'TOTAL 3 YEARS',
      co2: 'CO2 & CANTONAL TAX', marche: 'MARKET RANGE',
      taxe: "Calculate on your canton's official website",
      red: 'RED FLAGS', alerte: 'ALERT', problemes: 'KNOWN MODEL ISSUES',
      checklist: 'VISIT CHECKLIST', questions: 'QUESTIONS FOR THE SELLER',
      conseil: 'BUYING ADVICE', verdict: 'FINAL VERDICT',
      prix_suggere: 'SUGGESTED PRICE', economie: '↓ Savings :',
      disclaimer: 'This report is a decision-support tool. It does not replace a physical inspection by a professional.',
      co2_nr: 'Not specified'
    }
  };

  const L = labels[langue] || labels.fr;

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

  const moisRapport = getMoisRapport(langue);

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { font-family: 'Plus Jakarta Sans', Arial, sans-serif; background: #f0f6ff; color: #0d1b35; font-size: 13px; height: auto !important; }
  .header { background: linear-gradient(135deg, #1a3a6e, #2952a3); padding: 18px 22px; border-bottom: 2px solid #00B4D8; }
  .header-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; }
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
  .scores-bar { padding: 12px 22px; page-break-inside: avoid; background: #fff; border-bottom: 1px solid #d0e4f7; }
  .scores-bar-title { font-size: 9px; color: #5a7a9a; letter-spacing: 1px; margin-bottom: 10px; }
  .scores-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
  .score-item { text-align: center; }
  .score-item-label { font-size: 9px; color: #5a7a9a; letter-spacing: 1px; margin-bottom: 3px; }
  .score-item-num { font-size: 40px; font-weight: 900; line-height: 1; margin-bottom: 5px; }
  .score-bar-bg { height: 7px; background: #d0e4f7; border-radius: 4px; }
  .score-bar-fill { height: 7px; border-radius: 4px; }
  .score-item-tag { font-size: 9px; font-weight: 700; margin-top: 3px; }
  .grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); border-bottom: 1px solid #d0e4f7; page-break-inside: avoid; }
  .cell { padding: 10px 12px; border-right: 1px solid #d0e4f7; }
  .cell:last-child { border-right: none; }
  .cell-label { font-size: 9px; color: #5a7a9a; letter-spacing: 1px; margin-bottom: 3px; text-transform: uppercase; }
  .cell-value { font-size: 14px; font-weight: 700; color: #0d1b35; }
  .cell-unit { font-size: 12px; color: #5a7a9a; font-weight: 600; }
  .grid-white { background: #fff; }
  .grid-light { background: #f0f6ff; }
  .section { padding: 16px 22px; border-bottom: 1px solid #d0e4f7; page-break-inside: avoid; }
  .section-white { background: #fff; }
  .section-light { background: #f0f6ff; }
  .section-title { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .section-bar { width: 4px; height: 16px; border-radius: 2px; flex-shrink: 0; }
  .section-label { font-size: 12px; font-weight: 700; letter-spacing: 1px; }
  .description-box { background: #f0f6ff; border-radius: 6px; padding: 10px 12px; font-size: 12px; color: #3a5a7a; line-height: 1.55; border-left: 3px solid #1a3a6e; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 5px; }
  .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 5px; }
  .point-card { background: #fff; border-radius: 5px; padding: 7px 10px; font-size: 12px; color: #0d1b35; }
  .point-card-light { background: #f0f6ff; border-radius: 5px; padding: 6px 9px; font-size: 11px; color: #0d1b35; }
  .checklist-item { background: #f0f6ff; border-radius: 5px; padding: 9px 10px; font-size: 12px; color: #0d1b35; display: flex; align-items: center; gap: 7px; margin-bottom: 4px; }
  .icon-check { display:inline-block; width:14px; height:14px; background:#28a745; border-radius:50%; color:#fff; text-align:center; line-height:14px; font-size:10px; font-weight:bold; flex-shrink:0; }
  .icon-warn { display:inline-block; width:14px; height:14px; background:#d4a00a; border-radius:50%; color:#fff; text-align:center; line-height:14px; font-size:10px; font-weight:bold; flex-shrink:0; }
  .icon-cross { display:inline-block; width:14px; height:14px; background:#dc3545; border-radius:50%; color:#fff; text-align:center; line-height:14px; font-size:10px; font-weight:bold; flex-shrink:0; }
  .icon-q { display:inline-block; width:14px; height:14px; background:#1a3a6e; border-radius:50%; color:#fff; text-align:center; line-height:14px; font-size:10px; font-weight:bold; flex-shrink:0; }
  .checklist-item-white { background: #fff; border-radius: 5px; padding: 9px 10px; font-size: 12px; color: #0d1b35; display: flex; align-items: center; gap: 7px; margin-bottom: 4px; }
  .costs-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; page-break-inside: avoid; }
  .cost-card { background: #fff; border-radius: 7px; padding: 12px; text-align: center; }
  .cost-label { font-size: 9px; color: #5a7a9a; letter-spacing: 1px; margin-bottom: 5px; }
  .cost-value { font-size: 15px; font-weight: 800; }
  .cost-note { font-size: 8px; color: #5a7a9a; margin-top: 3px; }
  .redflag-section { padding: 12px 22px; background: rgba(220,53,69,0.04); border-bottom: 2px solid #dc3545; page-break-inside: avoid; }
  .redflag-badge { background: #dc3545; border-radius: 4px; padding: 3px 10px; font-size: 10px; font-weight: 700; color: #fff; display: inline-block; margin-bottom: 8px; }
  .redflag-card { background: rgba(220,53,69,0.06); border-radius: 7px; padding: 8px; border: 1px solid rgba(220,53,69,0.2); margin-bottom: 5px; }
  .redflag-title { font-size: 12px; font-weight: 600; color: #dc3545; }
  .verdict-section { padding: 28px 22px; display: flex; justify-content: space-between; align-items: center; background: linear-gradient(135deg, #1a3a6e, #2952a3); page-break-inside: avoid; page-break-before: avoid; }
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
      <div class="report-num">${L.rapport} #${reportNumber} · ${moisRapport}</div>
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
      </div>
      <div class="score-item">
        <div class="score-item-label">${L.fiabilite}</div>
        <div class="score-item-num" style="color:${colour(analyse.score_fiabilite)};">${analyse.score_fiabilite}</div>
        <div class="score-bar-bg"><div class="score-bar-fill" style="width:${analyse.score_fiabilite*10}%;background:${colour(analyse.score_fiabilite)};"></div></div>
        <div class="score-item-tag" style="color:${colour(analyse.score_fiabilite)};">${scoreTag(analyse.score_fiabilite)}</div>
      </div>
      <div class="score-item">
        <div class="score-item-label">${L.entretien}</div>
        <div class="score-item-num" style="color:${colour(analyse.score_entretien)};">${analyse.score_entretien}</div>
        <div class="score-bar-bg"><div class="score-bar-fill" style="width:${analyse.score_entretien*10}%;background:${colour(analyse.score_entretien)};"></div></div>
        <div class="score-item-tag" style="color:${colour(analyse.score_entretien)};">${scoreTag(analyse.score_entretien)}</div>
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
        <div class="cost-value" style="color:#d4a00a;">${analyse.cout_entretien_annee1?.toLocaleString()} CHF</div>
      </div>
      <div class="cost-card" style="border-top:3px solid #d4a00a;">
        <div class="cost-label">${L.total3}</div>
        <div class="cost-value" style="color:#d4a00a;">${analyse.cout_total_3ans?.toLocaleString()} CHF</div>
      </div>
      <div class="cost-card" style="border-top:3px solid #1a3a6e;">
        <div class="cost-label">${L.co2}</div>
        <div class="cost-value" style="color:#1a3a6e;">${analyse.co2 ? analyse.co2 + ' g/km' : L.co2_nr}</div>
        ${analyse.co2 ? `<div class="cost-note" style="font-size:9px; color:#5a7a9a; margin-top:3px;">${L.taxe}</div>` : ''}
      </div>
      <div class="cost-card" style="border-top:3px solid #5a7a9a;">
        <div class="cost-label">${L.marche}</div>
        <div class="cost-value" style="color:#5a7a9a;font-size:12px;">${analyse.fourchette_marche_min?.toLocaleString()} – ${analyse.fourchette_marche_max?.toLocaleString()} CHF</div>
      </div>
    </div>
  </div>

  ${analyse.red_flags?.length > 0 ? `
  <div class="redflag-section">
    <div class="redflag-badge">${L.red}</div>
    ${analyse.red_flags.map(r => `<div class="redflag-card"><div class="redflag-title" style="color:#dc3545; font-weight:700;">${L.alerte} — ${r}</div></div>`).join('')}
  </div>` : ''}

  ${analyse.problemes_connus_modele?.length > 0 ? `
  <div class="section section-white">
    <div class="section-title"><div class="section-bar" style="background:#d4a00a;"></div><div class="section-label" style="color:#d4a00a;">${L.problemes}</div></div>
    ${analyse.problemes_connus_modele.map(p => `<div class="checklist-item-white" style="border-left:3px solid #d4a00a;"><span style="color:#d4a00a; font-weight:700; margin-right:6px;">!</span>${p}</div>`).join('')}
  </div>` : ''}

  <div class="section section-light">
    <div class="section-title"><div class="section-bar" style="background:#28a745;"></div><div class="section-label" style="color:#28a745;">${L.checklist}</div></div>
    ${(analyse.checklist_visite || []).map(c => `<div class="checklist-item" style="border-left:3px solid #28a745;"><span style="color:#28a745; font-weight:700; margin-right:6px;">></span>${c}</div>`).join('')}
  </div>

  <div class="section section-white">
    <div class="section-title"><div class="section-bar" style="background:#1a3a6e;"></div><div class="section-label" style="color:#1a3a6e;">${L.questions}</div></div>
    ${(analyse.questions_vendeur || []).map(q => `<div class="checklist-item-white" style="border-left:3px solid #1a3a6e;"><span style="color:#1a3a6e; font-weight:700; margin-right:6px;">?</span>${q}</div>`).join('')}
  </div>

  ${analyse.conseil_achat ? `
  <div class="section section-white" style="page-break-inside:avoid;">
    <div class="section-title"><div class="section-bar" style="background:#1a6e3a;"></div><div class="section-label" style="color:#1a6e3a;">${L.conseil}</div></div>
    <p style="font-size:12px; color:#0d1b35; line-height:1.7; padding:6px 0;">${analyse.conseil_achat}</p>
  </div>` : ''}

  <div class="verdict-section">
    <div>
      <div class="verdict-label">${L.verdict}</div>
      <div class="verdict-value" style="color:${verdictColor[analyse.verdict] || '#d4a00a'};">${traduireVerdict(analyse.verdict, langue)}</div>
      <div class="verdict-desc">${analyse.resume_verdict}</div>
    </div>
    <div style="text-align:right;">
      <div style="font-size:10px;color:#b8d0f0;margin-bottom:4px;">${L.prix_suggere}</div>
      <div style="font-size:38px;font-weight:900;color:#fff;">${analyse.prix_negocie_suggere?.toLocaleString()} CHF</div>
      <div style="font-size:10px;color:#00B4D8;margin-top:4px;">${L.economie} ${analyse.economie_potentielle_min?.toLocaleString()} – ${analyse.economie_potentielle_max?.toLocaleString()} CHF</div>
    </div>
  </div>

  <div class="footer">
    Source : ${url}<br>
    ${L.disclaimer}<br>
    EasyCarCheck · easycarcheck.ch · contact@easycarcheck.ch · Suisse
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
      format: 'A4',
      printBackground: true,
      margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' }
    });
    return pdfBuffer;
  } finally {
    await browser.close();
  }
}

// ─── ENVOI EMAIL ─────────────────────────────────────────
async function envoyerEmail(email, pdfBuffer, analyse, reportNumber, langue = 'fr') {
  const emailLabels = {
    fr: {
      subject: `Votre rapport EasyCarCheck`,
      analyse: 'VOTRE ANALYSE',
      pret: 'Votre rapport est prêt !',
      pret_sub: 'Il est joint à cet email en pièce jointe PDF.',
      ki: 'Analyse IA · Marché Suisse',
      pdf_titre: 'Rapport PDF en pièce jointe',
      pdf_nom: `EasyCarCheck_Rapport_${reportNumber}.pdf`,
      contenu: 'Red flags, checklist visite, prix de négociation',
      contenu_sub: 'Tout est dans le rapport PDF joint',
      spam: 'Rapport non reçu ?',
      spam_sub: 'Vérifiez vos spams',
      disclaimer: "Ce rapport est un outil d'aide à la décision. Il ne remplace pas une inspection physique par un professionnel.",
      footer_links: 'Site web · Mentions légales · Contact'
    },
    de: {
      subject: `Ihr EasyCarCheck-Bericht`,
      analyse: 'IHRE ANALYSE',
      pret: 'Ihr Bericht ist bereit!',
      pret_sub: 'Er ist als PDF-Anhang an diese E-Mail angehängt.',
      ki: 'KI-Analyse · Schweizer Markt',
      pdf_titre: 'PDF-Bericht im Anhang',
      pdf_nom: `EasyCarCheck_Bericht_${reportNumber}.pdf`,
      contenu: 'Warnhinweise, Besichtigungs-Checkliste, Verhandlungspreis',
      contenu_sub: 'Alles im beigefügten PDF-Bericht',
      spam: 'Bericht nicht erhalten?',
      spam_sub: 'Überprüfen Sie Ihren Spam-Ordner',
      disclaimer: 'Dieser Bericht ist ein Entscheidungshilfe-Tool. Er ersetzt keine physische Inspektion durch einen Fachmann.',
      footer_links: 'Website · Impressum · Kontakt'
    },
    it: {
      subject: `Il tuo rapporto EasyCarCheck`,
      analyse: 'LA TUA ANALISI',
      pret: 'Il tuo rapporto è pronto!',
      pret_sub: 'È allegato a questa email in formato PDF.',
      ki: 'Analisi IA · Mercato Svizzero',
      pdf_titre: 'Rapporto PDF in allegato',
      pdf_nom: `EasyCarCheck_Rapporto_${reportNumber}.pdf`,
      contenu: 'Segnalazioni, checklist visita, prezzo di trattativa',
      contenu_sub: 'Tutto nel rapporto PDF allegato',
      spam: 'Rapporto non ricevuto?',
      spam_sub: 'Controlla la cartella spam',
      disclaimer: "Questo rapporto è uno strumento di supporto decisionale. Non sostituisce un'ispezione fisica da parte di un professionista.",
      footer_links: 'Sito web · Note legali · Contatto'
    },
    en: {
      subject: `Your EasyCarCheck Report`,
      analyse: 'YOUR ANALYSIS',
      pret: 'Your report is ready!',
      pret_sub: 'It is attached to this email as a PDF.',
      ki: 'AI Analysis · Swiss Market',
      pdf_titre: 'PDF Report attached',
      pdf_nom: `EasyCarCheck_Report_${reportNumber}.pdf`,
      contenu: 'Red flags, visit checklist, negotiation price',
      contenu_sub: 'Everything is in the attached PDF report',
      spam: 'Report not received?',
      spam_sub: 'Check your spam folder',
      disclaimer: 'This report is a decision-support tool. It does not replace a physical inspection by a professional.',
      footer_links: 'Website · Legal notice · Contact'
    }
  };

  const EL = emailLabels[langue] || emailLabels.fr;

  const verdictEmailColor = ['ACHETER','KAUFEN','BUY','ACQUISTARE'].includes(analyse.verdict) ? '#28a745'
    : ['ÉVITER','MEIDEN','AVOID','EVITARE'].includes(analyse.verdict) ? '#dc3545' : '#d4a00a';
  const scoreEmailColor = analyse.score_global >= 7 ? '#28a745' : analyse.score_global >= 5 ? '#d4a00a' : '#dc3545';

  const result = await resend.emails.send({
    from: 'EasyCarCheck <contact@easycarcheck.ch>',
    to: email,
    subject: `● ${EL.subject} #${reportNumber} — ${analyse.marque} ${analyse.modele}`,
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
    <div style="font-size:12px;color:#b8d0f0;margin-top:4px;">${EL.ki}</div>
  </td></tr>

  <tr><td style="background:#fff;padding:32px 28px;border-left:1px solid #d0e4f7;border-right:1px solid #d0e4f7;">

    <div style="text-align:center;margin-bottom:28px;">
      <div style="width:56px;height:56px;background:rgba(40,167,69,0.1);border:2px solid #28a745;border-radius:50%;margin:0 auto 14px;line-height:56px;font-size:26px;text-align:center;">&#10003;</div>
      <h1 style="font-size:22px;font-weight:900;color:#0d1b35;margin:0 0 6px;">${EL.pret}</h1>
      <p style="font-size:14px;color:#5a7a9a;margin:0;">${EL.pret_sub}</p>
    </div>

    <div style="background:#f0f6ff;border-radius:10px;padding:18px 20px;margin-bottom:24px;border:1px solid #d0e4f7;">
      <div style="font-size:11px;color:#5a7a9a;letter-spacing:1px;margin-bottom:10px;">${EL.analyse}</div>
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
              <div style="font-size:9px;color:#5a7a9a;letter-spacing:1px;margin-bottom:4px;">${langue === 'de' ? 'BERICHT' : langue === 'it' ? 'RAPPORTO' : langue === 'en' ? 'REPORT' : 'RAPPORT'}</div>
              <div style="font-size:16px;font-weight:900;color:#1a3a6e;">#${reportNumber}</div>
            </div>
          </td>
        </tr>
      </table>
    </div>

    <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:24px;">
      <tr><td style="padding:12px 0;border-bottom:1px solid #f0f6ff;">
        <table><tr>
          <td style="font-size:18px;padding-right:12px;">&#128196;</td>
          <td>
            <div style="font-size:13px;font-weight:700;color:#0d1b35;">${EL.pdf_titre}</div>
            <div style="font-size:12px;color:#5a7a9a;">${EL.pdf_nom}</div>
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:12px 0;border-bottom:1px solid #f0f6ff;">
        <table><tr>
          <td style="font-size:18px;padding-right:12px;">&#128269;</td>
          <td>
            <div style="font-size:13px;font-weight:700;color:#0d1b35;">${EL.contenu}</div>
            <div style="font-size:12px;color:#5a7a9a;">${EL.contenu_sub}</div>
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:12px 0;">
        <table><tr>
          <td style="font-size:18px;padding-right:12px;">&#9888;</td>
          <td>
            <div style="font-size:13px;font-weight:700;color:#0d1b35;">${EL.spam}</div>
            <div style="font-size:12px;color:#5a7a9a;">${EL.spam_sub} · <a href="mailto:contact@easycarcheck.ch" style="color:#1a3a6e;">contact@easycarcheck.ch</a></div>
          </td>
        </tr></table>
      </td></tr>
    </table>

    <div style="background:#f0f6ff;border-radius:10px;padding:16px;border:1px solid #d0e4f7;text-align:center;">
      <p style="font-size:13px;color:#5a7a9a;margin:0;line-height:1.6;">${EL.disclaimer}</p>
    </div>

  </td></tr>

  <tr><td style="background:#1a3a6e;border-radius:0 0 12px 12px;padding:20px;text-align:center;">
    <div style="font-size:12px;color:#b8d0f0;margin-bottom:8px;">EasyCarCheck · easycarcheck.ch · Suisse</div>
    <div>
      <a href="https://easycarcheck.ch" style="font-size:11px;color:#8fa8c8;text-decoration:none;margin:0 8px;">${langue === 'de' ? 'Website' : langue === 'en' ? 'Website' : 'Site web'}</a>
      <a href="https://easycarcheck.ch/mentions-legales.html" style="font-size:11px;color:#8fa8c8;text-decoration:none;margin:0 8px;">${langue === 'de' ? 'Impressum' : langue === 'it' ? 'Note legali' : langue === 'en' ? 'Legal notice' : 'Mentions légales'}</a>
      <a href="mailto:contact@easycarcheck.ch" style="font-size:11px;color:#8fa8c8;text-decoration:none;margin:0 8px;">${langue === 'de' ? 'Kontakt' : langue === 'it' ? 'Contatto' : langue === 'en' ? 'Contact' : 'Contact'}</a>
    </div>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>
    `,
    attachments: [{
      filename: EL.pdf_nom,
      content: pdfBuffer.toString('base64')
    }]
  });
  console.log('RESEND RESULT:', JSON.stringify(result));
}

// ─── ROUTES ──────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'EasyCarCheck Backend OK ●' }));

app.post('/test-rapport', async (req, res) => {
  try {
    const { url, email, langue = 'fr' } = req.body;
    if (!url || !email) return res.status(400).json({ error: 'URL et email requis' });
    console.log('1. Démarrage analyse...');
    const reportNumber = String(Math.floor(Math.random() * 900) + 100).padStart(3, '0');
    const scraped = await scrapeAnnonce(url, langue);
    console.log('2. Scraping OK');
    const analyse = await analyserAvecGPT(scraped, langue, url);
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

app.post('/analyse-gratuite', async (req, res) => {
  try {
    const { url, langue = 'fr' } = req.body;
    if (!url) return res.status(400).json({ error: 'URL manquante' });
    const scraped = await scrapeAnnonce(url, langue);
    const analyse = await analyserAvecGPT(scraped, langue, url);
    res.json({
      marque: analyse.marque, modele: analyse.modele, annee: analyse.annee,
      prix: analyse.prix, score_global: analyse.score_global, verdict: analyse.verdict, teaser: true
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
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

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const { url, email, langue } = session.metadata;
    try {
      const reportNumber = String(Math.floor(Math.random() * 900) + 100).padStart(3, '0');
      const scraped = await scrapeAnnonce(url, langue);
      const analyse = await analyserAvecGPT(scraped, langue, url);
      const pdf = await genererPDF(analyse, reportNumber, url, langue);
      await envoyerEmail(email, pdf, analyse, reportNumber, langue);
      console.log(`✅ Rapport #${reportNumber} envoyé à ${email}`);
    } catch (err) {
      console.error('Erreur génération rapport:', err);
    }
  }
  res.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`● EasyCarCheck Backend running on port ${PORT}`));
