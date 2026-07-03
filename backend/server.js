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

    // Appel CSS extractor pour les équipements (toujours présent sur toutes les annonces)
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

    // Extraire les donnees structurees Next.js AVANT de supprimer les scripts
    let equipmentData = '';
    let co2Value = null;
    let optionsList = [];

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

      // CO2 — schema.org: "emissionsCO2":"210 g/km" OU JSON échappé \"co2Emission\":210
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

    // Nettoyer le HTML
    let cleanHtml = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
    cleanHtml = cleanHtml.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
    cleanHtml = cleanHtml.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, "");
    cleanHtml = cleanHtml.replace(/<[^>]+>/g, " ");
    cleanHtml = cleanHtml.replace(/\s+/g, " ").trim();

    const finalContent = cleanHtml.substring(0, 35000);
    console.log("ZENROWS OK:", finalContent.substring(0, 500));

    // FIX: retourner equipmentData, co2Value et optionsList avec le html
    return { html: finalContent, url: url, equipmentData: equipmentData, co2: co2Value, options: optionsList };
  } catch (err) {
    console.log('ZENROWS ERROR:', err.response?.data || err.message);
    return { html: `URL: ${url}`, url: url, equipmentData: '', co2: null, options: [] };
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

  // FIX: injecter equipmentData directement dans le prompt
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
- Couleur exacte — cherche PARTOUT dans la page (titre, description, caractéristiques, "Denim Blue", "Noir", etc). Si introuvable, mets "Non communiquée"
- Transmission (2 roues motrices / 4 roues motrices)
- Description complète du vendeur
- TOUTES les options et équipements listés — utilise la liste de la section "DONNÉES STRUCTURÉES" ci-dessus en priorité (elle est complète), supprimer les doublons, traduire tout en ${langues[langue] || 'français'}, supprimer les mentions "Détails consultez la liste de prix" et "Details siehe Preisliste"

ÉTAPE 2 - Analyse approfondie :
- Compare le prix avec le marché suisse actuel et calcule fourchette marché min et max réaliste. IMPORTANT : tiens compte de la GÉNÉRATION exacte, de la carrosserie, et de l'équipement. Fourchettes réalistes sur le marché suisse 2026 :
  * RS3 8V Phase 1 2015-2016 : 30000-40000 CHF
  * RS3 8V Phase 2 2017-2020 : 42000-55000 CHF
  * RS3 8P 2007-2012 : 20000-32000 CHF
  * M3 F80 2014-2018 berline : 52000-72000 CHF
  * M3 F80 Competition berline : 58000-78000 CHF
  * M3 F80 manuelle rare : +10-15% sur la fourchette
  * M4 F82 Competition : 55000-75000 CHF
  * M5 F10 2011-2016 : 35000-52000 CHF
  * Golf GTI Mk7 2013-2017 : 18000-28000 CHF
  * Golf R Mk7 2014-2019 : 25000-38000 CHF
  * RS6 C7 2013-2018 : 48000-72000 CHF
  * RS6 C8 2019+ : 80000-110000 CHF
  * C63 AMG W205 berline/break 2015-2018 : 42000-58000 CHF
  * C63 S AMG W205 berline/break 2015-2018 : 48000-65000 CHF
  * C63 AMG W205 Coupé 2015-2018 : 50000-68000 CHF
  * C63 S AMG W205 Coupé 2015-2018 : 58000-78000 CHF
  * C63 S AMG W205 2019-2021 : 68000-90000 CHF
  * A35 AMG W177 2019-2022 : 28000-42000 CHF
  * A45 S AMG W177 2019-2022 : 42000-58000 CHF
  * BMW M135i F20 2012-2016 : 20000-32000 CHF
  * BMW 320i/330i F30 2012-2018 : 15000-28000 CHF
  * Porsche Macan 2014-2018 : 35000-55000 CHF
  * Porsche 911 991 2011-2019 : 70000-120000 CHF
  Pour les modèles non listés, estime selon le segment et l'année. Si le prix demandé dépasse la fourchette haute de plus de 15% → score_prix 3-4 et signaler dans points_negatifs. Si le prix est dans la fourchette → score_prix 6-8 selon la précision.

- PROBLÈMES CONNUS DU MODÈLE : Utilise ta connaissance réelle et documentée. Sois précis sur la génération et la motorisation exacte. Fais la distinction entre :
  * PROBLÈME SYSTÉMATIQUE (défaut de conception indépendant de l'usage) → pénalise fortement le score fiabilité
  * PROBLÈME LIÉ À L'ABUS (launch control, circuit, mauvais entretien) → mentionne-le avec un avertissement mais pénalise moins le score
  * Exemples SYSTÉMATIQUES : M5 F10 S63 (injecteurs défaillants, turbo fragile, consommation huile excessive même usage normal), E92 M3 S65 (pompe à huile défaillante, roulements vilebrequin), Porsche 987 Cayman/Boxster (roulement IMS), Range Rover suspension pneumatique, Mercedes A35/A45 AMG culasse M260/M139
  * Exemples LIÉS À L'ABUS : M3 F80 S55 (rupture bielle si launch control intensif — fiable sans abus), RS6 C7 4.0 TFSI (consommation huile si launch control — solide en usage normal), Golf GTI Mk7 DSG7 DQ200 (surchauffe en usage urbain intensif)
  * NE JAMAIS mettre des généralités vagues comme "usure des freins" ou "capteurs de stationnement" sauf si c'est un vrai problème documenté du modèle
  * Pour les problèmes liés à l'abus : formuler comme "Risque de rupture de bielle S55 en cas d'usage intensif du launch control — à vérifier avec le vendeur" plutôt que de condamner le modèle
- problemes_connus_modele : exactement 2 problèmes RÉELS et PRÉCIS avec génération et motorisation, en précisant si c'est systématique ou lié à l'usage
- questions_vendeur : adapter SPÉCIFIQUEMENT aux problèmes connus du modèle. Pour les modèles à risque launch control : demander "Le véhicule a-t-il été utilisé sur circuit ou avec launch control fréquemment ?" Pour les modèles à consommation huile : "Quelle est la consommation d'huile entre deux vidanges ?"
- checklist_visite : adapter au modèle. Pour les modèles à risque moteur : "Effectuer un relevé de compression moteur" / "Vérifier la consommation d'huile sur 1000 km" / "Inspecter les traces d'huile sous le véhicule"

- SCORING RÉALISTE, NUANCÉ ET VARIÉ — NE PAS systématiquement mettre 7. Règles strictes :
  * score_prix : 9-10=excellente affaire nettement sous-cotée, 7-8=prix correct dans la fourchette marché, 5-6=prix légèrement au-dessus, 3-4=prix trop élevé, 1-2=prix abusif
  * score_fiabilite — nuance OBLIGATOIRE entre systématique et lié à l'abus :
    - 9-10 : modèle très fiable et robuste (Toyota GR86, Honda Civic Type R FK8, Mazda MX-5 ND, Porsche 911 996 sans IMS)
    - 7-8 : bonne fiabilité globale, quelques points faibles mineurs ou liés à l'entretien (BMW M3 F80 S55 bien entretenue sans abus, Audi RS6 C7 usage normal, VW Golf GTI Mk7 usage raisonnable)
    - 5-6 : fiabilité moyenne, problèmes connus mais gérables (Audi RS3 8V turbo à surveiller, BMW 335i N55 chaîne distribution)
    - 3-4 : problèmes systématiques sérieux indépendants de l'usage (BMW M5 F10 S63, E92 M3 S65, Porsche 987 IMS, Range Rover suspension pneumatique)
    - 1-2 : modèle très problématique, risque financier élevé même bien entretenu
  * score_entretien : 9-10=très économique <500 CHF/an, 7-8=raisonnable 800-1200 CHF/an, 5-6=assez coûteux 1500-2500 CHF/an, 3-4=très coûteux 3000-5000 CHF/an, 1-2=extrêmement coûteux >5000 CHF/an
  * VERDICT : ACHETER si score_global >= 8 ET pas de red flags majeurs, NÉGOCIER si score_global 5-7 OU prix à revoir, ÉVITER si score_global <= 4 OU problèmes systématiques graves OU red flags critiques (culasse remplacée, accident grave, moteur défaillant)
  * VARIE RÉELLEMENT les scores selon la réalité — une M5 F10 doit scorer 3-4 en fiabilité, une M3 F80 bien entretenue peut scorer 7

- CULASSE : Si "Zylinderkopf", "culasse", "cylindre" mentionné dans l'annonce → ajouter "Culasse remplacée" dans red_flags ET points_negatifs, baisser score_fiabilite de 2 points minimum → verdict ÉVITER automatique
- ACCIDENT : Si accident mentionné → red flag obligatoire, baisser score_fiabilite de 1-2 points selon gravité
- INTERDITS comme points négatifs : "consommation de carburant élevée", "consommation d'huile élevée", "kilométrage élevé", "kilométrage relativement élevé", "kilométrage important", "consommation élevée"
- KILOMÉTRAGE : NE JAMAIS mentionner le kilométrage comme point négatif
- SPORTIVES (RS, AMG, M, S, R) : Ne pas mentionner la consommation comme point négatif
- FREE SERVICE BMW, Audi, Mercedes, Volvo : valable 10 ans OU 100000 km depuis la 1ere mise en circulation. Calcul STRICT et OBLIGATOIRE : si (annee_vehicule + 10 > 2026) ET (kilometrage < 100000) alors ENCORE sous free service. EXEMPLES : vehicule 2015 → 2015+10=2025, 2025 < 2026 donc HORS free service. Vehicule 2017 → 2017+10=2027, 2027 > 2026 donc ENCORE sous free service. Si HORS free service : NE PAS mentionner le free service dans points_positifs, appliquer les couts sans free service. Si ENCORE sous free service, estimer les couts reels (liquides, pneus, plaquettes NON couverts) et mentionner dans points_positifs. Couts selon le type :
  * Citadine ou compacte sous free service : cout_entretien_annee1 = 250, cout_total_3ans = 750, score_entretien = 9
  * Berline ou SUV standard sous free service : cout_entretien_annee1 = 400, cout_total_3ans = 1200, score_entretien = 8
  * Sportive premium M AMG RS S sous free service : cout_entretien_annee1 = 800, cout_total_3ans = 2400, score_entretien = 7
  * Ultra-sportive M3 M5 RS6 C63 A45 sous free service : cout_entretien_annee1 = 1200, cout_total_3ans = 3600, score_entretien = 6
- Sans free service (hors periode ou marque non concernee) : estimer les couts ENTRETIEN COURANT uniquement (vidange, filtres, revision, liquides, freins) — NE PAS inclure les reparations imprevisibles (turbo, boite, moteur) dans ce chiffre. Fourchettes realistes :
  * Voiture compacte ou citadine : cout_entretien_annee1 = 500, cout_total_3ans = 1500, score_entretien = 8
  * Berline ou break standard : cout_entretien_annee1 = 800, cout_total_3ans = 2400, score_entretien = 7
  * SUV ou 4x4 standard : cout_entretien_annee1 = 1000, cout_total_3ans = 3000, score_entretien = 6
  * Sportive premium RS AMG M S hors free service : cout_entretien_annee1 = 1200, cout_total_3ans = 3600, score_entretien = 5 (freins sport, huile performance, revision annuelle)
  * Ultra-sportive M3 M5 RS6 C63 A45 hors free service : cout_entretien_annee1 = 1500, cout_total_3ans = 4500, score_entretien = 4 (freins sport intensif, huile specifique, pneumatiques performance)
- BOÎTE : "Manuelle robotisée" = "Automatique (DCT)" pour Mercedes AMG
- DESCRIPTION VENDEUR : Traduire INTÉGRALEMENT en ${langues[langue] || 'français'} en phrases claires et lisibles. "Zylinderkopf" = "culasse". Jamais "cylindre de tête" ou "cylindre tête"
- Ne jamais inventer des points négatifs absents de l'annonce
- score_global = mettre 0 (calculé automatiquement par le système)
- taxe_cantonale_ge = mettre 0 (calculé automatiquement par le système)
- score_prix, score_fiabilite, score_entretien : OBLIGATOIRE entre 1 et 10, JAMAIS 0. Un véhicule moyen = 5, bon = 7, excellent = 9, problème grave = 3
- options : inclure TOUTES les options de la liste DONNÉES STRUCTURÉES sans en supprimer, sans tronquer, sans limiter

QUANTITÉS STRICTES — NE PAS DÉPASSER :
- points_positifs : exactement 3 éléments — OBLIGATOIREMENT en ${langues[langue] || 'français'}
- points_negatifs : exactement 3 éléments — OBLIGATOIREMENT en ${langues[langue] || 'français'} (JAMAIS kilométrage, JAMAIS consommation pour sportives)
- checklist_visite : exactement 4 éléments
- questions_vendeur : exactement 3 questions
- problemes_connus_modele : exactement 2 éléments
- conseil_achat : 2-3 phrases de conseil d'achat personnalisé pour ce véhicule spécifique (budget total de possession, points de vigilance, positionnement marché)

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
}
IMPORTANT pour resume_verdict : écrire une phrase courte de synthèse (ex: "Ce véhicule présente un bon rapport qualité/prix mais nécessite une vérification de la chaîne de distribution.") — NE PAS répéter le mot ACHETER/NÉGOCIER/ÉVITER dans ce champ.`;

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

  // FIX: si GPT n'a pas trouvé le CO2 mais qu'on l'a extrait côté scraping, on l'utilise
  if ((!parsed.co2 || parsed.co2 === 0) && scrapedData.co2) {
    parsed.co2 = scrapedData.co2;
    console.log('CO2 injecté depuis scraping:', parsed.co2);
  }

  // Fix prix_negocie_suggere si 0 ou manquant
  if (!parsed.prix_negocie_suggere || parsed.prix_negocie_suggere === 0) {
    const prixBrut = parseInt(parsed.prix) || 0;
    parsed.prix_negocie_suggere = Math.round(prixBrut * 0.93);
    console.log('PRIX FALLBACK appliqué:', parsed.prix_negocie_suggere);
  }
  if (!parsed.economie_potentielle_min || parsed.economie_potentielle_min === 0) {
    const prixBrut = parseInt(parsed.prix) || 0;
    parsed.economie_potentielle_min = Math.round(prixBrut * 0.03);
    parsed.economie_potentielle_max = Math.round(prixBrut * 0.08);
  }
  if (!parsed.fourchette_marche_min || parsed.fourchette_marche_min === 0) {
    const prixBrut = parseInt(parsed.prix) || 0;
    parsed.fourchette_marche_min = Math.round(prixBrut * 0.88);
    parsed.fourchette_marche_max = Math.round(prixBrut * 1.05);
  }

  // FIX: Force scores entiers — si GPT retourne 0 c'est anormal, on met un minimum de 1
  parsed.score_prix = Math.max(1, Math.round(parsed.score_prix || 5));
  parsed.score_fiabilite = Math.max(1, Math.round(parsed.score_fiabilite || 5));
  parsed.score_entretien = Math.max(1, Math.round(parsed.score_entretien || 5));

  // FIX: recalcul score_global côté Node.js = moyenne arrondie des 3 scores
  parsed.score_global = Math.round((parsed.score_prix + parsed.score_fiabilite + parsed.score_entretien) / 3);

  // Si culasse remplacée → score_fiabilite max 5, recalculer global
  const culasseDetectee = (parsed.red_flags || []).some(r => r.toLowerCase().includes('culasse')) ||
    (parsed.points_negatifs || []).some(p => p.toLowerCase().includes('culasse'));
  if (culasseDetectee && parsed.score_fiabilite > 5) parsed.score_fiabilite = 5;
  if (culasseDetectee) {
    parsed.score_global = Math.round((parsed.score_prix + parsed.score_fiabilite + parsed.score_entretien) / 3);
  }

  // ─── CORRECTIONS PRIX AUTOMATIQUES ───────────────────
  const prixDemande = parseInt(parsed.prix) || 0;
  const fourchMin = parseInt(parsed.fourchette_marche_min) || 0;
  const fourchMax = parseInt(parsed.fourchette_marche_max) || 0;

  // 1. Prix suggéré doit être dans la fourchette marché
  if (fourchMin > 0 && fourchMax > 0 && parsed.prix_negocie_suggere) {
    if (parsed.prix_negocie_suggere > fourchMax) {
      parsed.prix_negocie_suggere = fourchMax;
      console.log('PRIX SUGGERE corrige fourchette max:', fourchMax);
    }
    if (parsed.prix_negocie_suggere < fourchMin) {
      parsed.prix_negocie_suggere = fourchMin;
      console.log('PRIX SUGGERE corrige fourchette min:', fourchMin);
    }
  }

  // 2. Économie recalculée par rapport au prix demandé réel
  if (prixDemande > 0 && parsed.prix_negocie_suggere > 0) {
    const economie = prixDemande - parsed.prix_negocie_suggere;
    if (economie > 0) {
      parsed.economie_potentielle_min = Math.round(economie * 0.7);
      parsed.economie_potentielle_max = Math.round(economie * 1.3);
    }
  }

  // 3. Verdict EVITER automatique si prix dépasse fourchette de plus de 15%
  if (fourchMax > 0 && prixDemande > fourchMax * 1.15) {
    parsed.verdict = 'EVITER';
    parsed.score_prix = Math.min(parsed.score_prix, 3);
    parsed.score_global = Math.round((parsed.score_prix + parsed.score_fiabilite + parsed.score_entretien) / 3);
    if (!parsed.resume_verdict) parsed.resume_verdict = 'Prix demandé nettement au-dessus de la valeur marché.';
    console.log('VERDICT force EVITER — prix', prixDemande, 'depasse fourchette max', fourchMax, 'de +15%');
  }

  // FIX: calcul taxe avec le CO2 réel (scraping prioritaire sur GPT)
  // Fallback par modèle si CO2 absent du scraping ET de GPT
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

  // FIX OPTIONS: bypass GPT — injecter directement les options du scraping si disponibles
  if (scrapedData.options && scrapedData.options.length > 0) {
    parsed.options = scrapedData.options
      .map(o => traduireOption(o))
      .filter(o => o !== null);
    console.log('OPTIONS injectées depuis scraping:', parsed.options.length, 'options');
  } else if (parsed.options && parsed.options.length > 0) {
    // Fallback: utiliser les options GPT si scraping vide
    parsed.options = parsed.options
      .map(o => traduireOption(o))
      .filter(o => o !== null);
    console.log('OPTIONS depuis GPT (fallback):', parsed.options.length, 'options');
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
    fr: { marque: 'MARQUE & MODÈLE', score_global: 'SCORE GLOBAL', rapport: 'Rapport', prix: 'PRIX', fiabilite: 'FIABILITÉ', entretien: 'ENTRETIEN', annee: 'ANNÉE', km: 'KILOMÉTRAGE', prix_dem: 'PRIX DEMANDÉ', puissance: 'PUISSANCE', carburant: 'CARBURANT', boite: 'BOÎTE', transmission: 'TRANSMISSION', couleur: 'COULEUR', desc: 'DESCRIPTION VENDEUR', scores: 'DÉTAIL DES SCORES', points: 'POINTS CLÉS', options: 'ÉQUIPEMENTS & OPTIONS', couts: 'COÛTS & MARCHÉ', entretien1: 'ENTRETIEN AN 1', total3: 'TOTAL 3 ANS', co2: 'CO2 & TAXE CANTONALE', marche: 'FOURCHETTE MARCHÉ', taxe: 'Taxe: site officiel de votre canton', red: 'RED FLAGS', alerte: 'ALERTE', problemes: 'PROBLÈMES CONNUS DU MODÈLE', checklist: 'CHECKLIST VISITE', questions: 'QUESTIONS À POSER AU VENDEUR', conseil: "CONSEIL D'ACHAT", verdict: 'VERDICT FINAL', disclaimer: "Ce rapport est un outil d'aide à la décision. Il ne remplace pas une inspection physique par un professionnel." },
    de: { marque: 'MARKE & MODELL', score_global: 'GESAMTBEWERTUNG', rapport: 'Bericht', prix: 'PREIS', fiabilite: 'ZUVERLÄSSIGKEIT', entretien: 'WARTUNG', annee: 'JAHR', km: 'KILOMETERSTAND', prix_dem: 'VERLANGTER PREIS', puissance: 'LEISTUNG', carburant: 'KRAFTSTOFF', boite: 'GETRIEBE', transmission: 'ANTRIEB', couleur: 'FARBE', desc: 'VERKÄUFERBESCHREIBUNG', scores: 'BEWERTUNGSDETAILS', points: 'WICHTIGE PUNKTE', options: 'AUSSTATTUNG & OPTIONEN', couts: 'KOSTEN & MARKT', entretien1: 'WARTUNG JAHR 1', total3: 'TOTAL 3 JAHRE', co2: 'CO2 & KANTONSSTEUER', marche: 'MARKTPREISSPANNE', taxe: 'Steuer: offizielle Kantonswebsite', red: 'WARNHINWEISE', alerte: 'WARNUNG', problemes: 'BEKANNTE MODELLPROBLEME', checklist: 'BESICHTIGUNGS-CHECKLISTE', questions: 'FRAGEN AN DEN VERKÄUFER', conseil: 'KAUFEMPFEHLUNG', verdict: 'ENDURTEIL', disclaimer: 'Dieser Bericht ist ein Entscheidungshilfe-Tool. Er ersetzt keine physische Inspektion durch einen Fachmann.' },
    it: { marque: 'MARCA & MODELLO', score_global: 'PUNTEGGIO GLOBALE', rapport: 'Rapporto', prix: 'PREZZO', fiabilite: 'AFFIDABILITÀ', entretien: 'MANUTENZIONE', annee: 'ANNO', km: 'CHILOMETRAGGIO', prix_dem: 'PREZZO RICHIESTO', puissance: 'POTENZA', carburant: 'CARBURANTE', boite: 'CAMBIO', transmission: 'TRAZIONE', couleur: 'COLORE', desc: 'DESCRIZIONE VENDITORE', scores: 'DETTAGLIO PUNTEGGI', points: 'PUNTI CHIAVE', options: 'EQUIPAGGIAMENTI & OPZIONI', couts: 'COSTI & MERCATO', entretien1: 'MANUTENZIONE ANNO 1', total3: 'TOTALE 3 ANNI', co2: 'CO2 & TASSA CANTONALE', marche: 'FASCIA DI MERCATO', taxe: 'Calcola sul sito ufficiale del tuo cantone', red: 'SEGNALAZIONI', alerte: 'ATTENZIONE', problemes: 'PROBLEMI NOTI DEL MODELLO', checklist: 'CHECKLIST VISITA', questions: 'DOMANDE AL VENDITORE', conseil: "CONSIGLIO D'ACQUISTO", verdict: 'VERDETTO FINALE', disclaimer: 'Questo rapporto è uno strumento di supporto decisionale.' },
    en: { marque: 'MAKE & MODEL', score_global: 'OVERALL SCORE', rapport: 'Report', prix: 'PRICE', fiabilite: 'RELIABILITY', entretien: 'MAINTENANCE', annee: 'YEAR', km: 'MILEAGE', prix_dem: 'ASKING PRICE', puissance: 'POWER', carburant: 'FUEL', boite: 'GEARBOX', transmission: 'DRIVE', couleur: 'COLOUR', desc: 'SELLER DESCRIPTION', scores: 'SCORE DETAILS', points: 'KEY POINTS', options: 'EQUIPMENT & OPTIONS', couts: 'COSTS & MARKET', entretien1: 'MAINTENANCE YEAR 1', total3: 'TOTAL 3 YEARS', co2: 'CO2 & CANTONAL TAX', marche: 'MARKET RANGE', taxe: "Calculate on your canton's official website", red: 'RED FLAGS', alerte: 'ALERT', problemes: 'KNOWN MODEL ISSUES', checklist: 'VISIT CHECKLIST', questions: 'QUESTIONS FOR THE SELLER', conseil: 'BUYING ADVICE', verdict: 'FINAL VERDICT', disclaimer: 'This report is a decision-support tool. It does not replace a physical inspection by a professional.' }
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

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800;900&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Noto+Emoji&display=swap" rel="stylesheet">
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
      <div class="report-num">${L.rapport} #${reportNumber} · JUIN 2026</div>
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
        <div class="cost-value" style="color:#1a3a6e;">${analyse.co2 ? analyse.co2 + ' g/km' : 'Non renseigné'}</div>
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
      ${analyse.resume_verdict ? `<div class="verdict-desc">${analyse.resume_verdict}</div>` : ''}
    </div>
    <div style="text-align:right;">
      <div style="font-size:10px;color:#b8d0f0;margin-bottom:4px;">${langue === "de" ? "EMPF. PREIS" : langue === "it" ? "PREZZO SUGGERITO" : langue === "en" ? "SUGGESTED PRICE" : "PRIX SUGGÉRÉ"}</div>
      <div style="font-size:38px;font-weight:900;color:#fff;">${analyse.prix_negocie_suggere?.toLocaleString()} CHF</div>
      <div style="font-size:10px;color:#00B4D8;margin-top:4px;">${langue === "de" ? "↓ Ersparnis :" : langue === "it" ? "↓ Risparmio :" : langue === "en" ? "↓ Savings :" : "↓ Économie :"} ${analyse.economie_potentielle_min?.toLocaleString()} – ${analyse.economie_potentielle_max?.toLocaleString()} CHF</div>
    </div>
  </div>

  <div class="footer">
    Source : ${url}<br>
    ${L.disclaimer}<br>
    EasyCarCheck · easycarcheck.ch · contact@easycarcheck.ch ·  Suisse
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
            <div style="font-size:13px;font-weight:700;color:#0d1b35;">Red flags, checklist visite, prix de négociation</div>
            <div style="font-size:12px;color:#5a7a9a;">Tout est dans le rapport PDF joint</div>
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
      <p style="font-size:13px;color:#5a7a9a;margin:0;line-height:1.6;">Ce rapport est un outil d'aide à la décision.<br>Il ne remplace pas une inspection physique par un professionnel.</p>
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
