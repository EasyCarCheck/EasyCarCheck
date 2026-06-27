require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { Resend } = require('resend');

const app = express();
app.use(cors());
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

// ─── SCRAPING ───────────────────────────────────────────
async function scrapeAnnonce(url) {
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
function traduireOption(opt) {
  const dict = {
    'Deaktivierung Beifahrerairbag': "Désactivation airbag passager",
    'Knieairbag Fahrer': "Airbag genoux conducteur",
    'Aussenspiegel elektrisch anklappbar': "Rétroviseurs électriques rabattables",
    'Innen- und Fahreraussenspiegel automatisch abblendbar': "Rétroviseurs intérieur et extérieur photochromatiques",
    'Details siehe Preisliste': null,
    'Détails consultez la liste de prix': null,
    'Sitzheizung vorne': "Sièges avant chauffants",
    'Wireless Charging für mobile Geräte': "Chargement sans fil pour appareils mobiles",
    'Roues en alliage léger 18\" AMG -5 rayons- doubles': 'Jantes 18" AMG 5 rayons',
    'ESP Elektronisches Stabilitätsprogramm': "Contrôle électronique de stabilité ESP",
    'LED Tagfahrlicht': "LED Phares de jour",
    'Rückfahrkamera': "Caméra de recul",
    'Reifendruck-Kontrollsystem RDK': "Système de contrôle pression pneus",
    'Seitenairbag Fahrer und Beifahrerseite': "Airbags latéraux conducteur et passager",
    'Airbag Fahrer und Beifahrerseite': "Airbags conducteur et passager",
    'Keine Gewähr auf die Angaben der Serienausstattungen': null,
    'Aucune garantie sur l exactitude de l équipement de série': null,
    'Alarmanlage mit Abschleppschutz u. Innenraumabsicherung': "Alarme avec protection remorquage",
    'Einbruch- und Diebstahlwarnanlage': "Système antivol",
    'Aussenspiegel elektrisch anklappbar': "Rétroviseurs électriques rabattables",
    'Soundsystem': "Système audio premium",
    'Éclairage d ambiance': "Éclairage d'ambiance",
    'Aileron arrière': "Aileron arrière AMG",
    'Spoiler frontal spécial': "Spoiler frontal AMG",
  };
  return dict[opt] !== undefined ? dict[opt] : opt;
}

// ─── ANALYSE GPT-4o ─────────────────────────────────────
async function analyserAvecGPT(scrapedData, langue, url) {
  const langues = { fr: 'français', de: 'allemand', it: 'italien', en: 'anglais' };

  // FIX: injecter equipmentData directement dans le prompt
  const equipmentSection = scrapedData.equipmentData
    ? `\n\nDONNÉES STRUCTURÉES EXTRAITES (priorité sur le texte brut) :\n${scrapedData.equipmentData}`
    : '';

  const prompt = `Tu es un expert en analyse de véhicules d'occasion sur le marché suisse.

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
- Compare le prix avec le marché suisse actuel et calcule fourchette marché min et max réaliste
- Pour Mercedes A35 AMG : problème culasse moteur M260 récurrent (remplacement 5000-8000 CHF hors garantie), boîte DCT fragile
- CULASSE : Si "Zylinderkopf", "culasse", "cylindre" mentionné → ajouter EXACTEMENT "Culasse remplacée" dans red_flags ET points_negatifs. JAMAIS dans points_positifs. Toujours "Culasse remplacée" comme terme exact
- Si culasse remplacée → baisser score_fiabilite de 2 points et score_global de 1 point
- INTERDITS comme points négatifs : "consommation de carburant élevée", "consommation d'huile élevée"
- KILOMÉTRAGE : Ne qualifier d'élevé QUE si >25000 km/an. 54500 km en 2021 = ~13000 km/an = NORMAL, ne pas mentionner
- FREE SERVICE Mercedes : cout_entretien_annee1 = 250, cout_total_3ans = 750. Mentionner dans points_positifs "Entretien main d'oeuvre et pièces couvert par Mercedes (liquides à la charge du propriétaire)"
- Sans free service : estimer les coûts selon le modèle
- BOÎTE : "Manuelle robotisée" = "Automatique (DCT)" pour Mercedes AMG
- DESCRIPTION VENDEUR : Traduire INTÉGRALEMENT en ${langues[langue] || 'français'} en phrases claires et lisibles. "Zylinderkopf" = "culasse". Jamais "cylindre de tête" ou "cylindre tête"
- Ne jamais inventer des points négatifs absents de l'annonce
- score_global = mettre 0 (calculé automatiquement par le système)
- taxe_cantonale_ge = mettre 0 (calculé automatiquement par le système)
- score_prix, score_fiabilite, score_entretien : OBLIGATOIRE entre 1 et 10, JAMAIS 0. Un véhicule moyen = 5, bon = 7, excellent = 9, problème grave = 3
- options : inclure TOUTES les options de la liste DONNÉES STRUCTURÉES sans en supprimer, sans tronquer, sans limiter

QUANTITÉS STRICTES — NE PAS DÉPASSER :
- points_positifs : exactement 3 éléments
- points_negatifs : exactement 3 éléments
- checklist_visite : exactement 4 éléments
- questions_vendeur : exactement 3 questions
- problemes_connus_modele : exactement 2 éléments

ÉTAPE 3 - Génère le rapport en ${langues[langue] || 'français'}.

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

  // FIX: si GPT n'a pas trouvé le CO2 mais qu'on l'a extrait côté scraping, on l'utilise
  if ((!parsed.co2 || parsed.co2 === 0) && scrapedData.co2) {
    parsed.co2 = scrapedData.co2;
    console.log('CO2 injecté depuis scraping:', parsed.co2);
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

  // FIX OPTIONS: bypass GPT — injecter directement les options du scraping si disponibles
  if (scrapedData.options && scrapedData.options.length > 0) {
    parsed.options = scrapedData.options
      .map(o => traduireOption(o))
      .filter(o => o !== null);
    console.log('OPTIONS injectées depuis scraping:', parsed.options.length, 'options');
  }

  // Nettoyer puissance
  parsed.puissance = nettoyerPuissance(parsed.puissance);

  // Limiter strictement les quantités
  if (parsed.points_positifs?.length > 3) parsed.points_positifs = parsed.points_positifs.slice(0, 3);
  if (parsed.points_negatifs?.length > 3) parsed.points_negatifs = parsed.points_negatifs.slice(0, 3);
  if (parsed.checklist_visite?.length > 4) parsed.checklist_visite = parsed.checklist_visite.slice(0, 4);
  if (parsed.questions_vendeur?.length > 3) parsed.questions_vendeur = parsed.questions_vendeur.slice(0, 3);
  if (parsed.problemes_connus_modele?.length > 2) parsed.problemes_connus_modele = parsed.problemes_connus_modele.slice(0, 2);

  return parsed;
}

// ─── GÉNÉRATION PDF ──────────────────────────────────────
async function genererPDF(analyse, reportNumber, url) {
  const verdictColor = {
    'ACHETER': '#28a745', 'NÉGOCIER': '#d4a00a', 'ÉVITER': '#dc3545',
    'VERHANDELN': '#d4a00a', 'KAUFEN': '#28a745', 'MEIDEN': '#dc3545',
    'NEGOTIATE': '#d4a00a', 'BUY': '#28a745', 'AVOID': '#dc3545',
    'ACQUISTARE': '#28a745', 'TRATTARE': '#d4a00a', 'EVITARE': '#dc3545'
  };
  const colour = (score) => score >= 7 ? '#28a745' : score >= 5 ? '#d4a00a' : '#dc3545';
  const badge = (score) => score >= 8 ? 'EXCELLENT' : score >= 7 ? 'BIEN ÉVALUÉ' : score >= 5 ? 'MOYEN' : 'À ÉVITER';
  const scoreTag = (score) => score >= 8 ? 'EXCELLENT' : score >= 7 ? 'BIEN ÉVALUÉ' : score >= 5 ? 'MOYEN' : 'À SURVEILLER';

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
  .scores-bar { padding: 8px 22px; page-break-inside: avoid; background: #fff; border-bottom: 1px solid #d0e4f7; }
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
  .section { padding: 10px 22px; border-bottom: 1px solid #d0e4f7; page-break-inside: avoid; }
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
  .checklist-item { background: #f0f6ff; border-radius: 5px; padding: 5px 10px; font-size: 12px; color: #0d1b35; display: flex; align-items: center; gap: 7px; margin-bottom: 4px; }
  .checklist-item-white { background: #fff; border-radius: 5px; padding: 5px 10px; font-size: 12px; color: #0d1b35; display: flex; align-items: center; gap: 7px; margin-bottom: 4px; }
  .costs-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; page-break-inside: avoid; }
  .cost-card { background: #fff; border-radius: 7px; padding: 8px; text-align: center; }
  .cost-label { font-size: 9px; color: #5a7a9a; letter-spacing: 1px; margin-bottom: 5px; }
  .cost-value { font-size: 15px; font-weight: 800; }
  .cost-note { font-size: 8px; color: #5a7a9a; margin-top: 3px; }
  .redflag-section { padding: 12px 22px; background: rgba(220,53,69,0.04); border-bottom: 2px solid #dc3545; page-break-inside: avoid; }
  .redflag-badge { background: #dc3545; border-radius: 4px; padding: 3px 10px; font-size: 10px; font-weight: 700; color: #fff; display: inline-block; margin-bottom: 8px; }
  .redflag-card { background: rgba(220,53,69,0.06); border-radius: 7px; padding: 7px; border: 1px solid rgba(220,53,69,0.2); margin-bottom: 5px; }
  .redflag-title { font-size: 12px; font-weight: 600; color: #dc3545; }
  .verdict-section { padding: 14px 22px; display: flex; justify-content: space-between; align-items: center; background: linear-gradient(135deg, #1a3a6e, #2952a3); page-break-inside: avoid; page-break-before: avoid; }
  .verdict-label { font-size: 10px; color: #b8d0f0; letter-spacing: 2px; margin-bottom: 5px; }
  .verdict-value { font-size: 26px; font-weight: 900; letter-spacing: 2px; }
  .verdict-desc { font-size: 11px; color: #b8d0f0; margin-top: 6px; max-width: 280px; line-height: 1.5; }
  .footer { padding: 10px 22px; background: #f0f6ff; border-top: 1px solid #d0e4f7; font-size: 9px; color: #5a7a9a; text-align: center; line-height: 1.6; page-break-inside: avoid; }
</style>
</head>
<body>

  <div class="header">
    <div class="header-top">
      <div class="logo">🚗 EASY<span>CAR</span>CHECK</div>
      <div class="report-num">Rapport #${reportNumber} · JUIN 2026</div>
    </div>
    <div class="header-main">
      <div>
        <div class="car-brand-label">MARQUE &amp; MODÈLE</div>
        <div class="car-brand">${analyse.marque?.toUpperCase()}</div>
        <div class="car-model">${analyse.modele?.toUpperCase()}</div>
      </div>
      <div class="score-box" style="border: 2px solid ${colour(analyse.score_global)};">
        <div class="score-label">SCORE GLOBAL</div>
        <div class="score-num" style="color: ${colour(analyse.score_global)};">${analyse.score_global}</div>
        <div class="score-denom">/10</div>
        <div class="score-badge" style="background: ${colour(analyse.score_global)};">${badge(analyse.score_global)}</div>
      </div>
    </div>
  </div>

  <div class="scores-bar">
    <div class="scores-bar-title">DÉTAIL DES SCORES</div>
    <div class="scores-grid">
      <div class="score-item">
        <div class="score-item-label">PRIX</div>
        <div class="score-item-num" style="color:${colour(analyse.score_prix)};">${analyse.score_prix}</div>
        <div class="score-bar-bg"><div class="score-bar-fill" style="width:${analyse.score_prix*10}%;background:${colour(analyse.score_prix)};"></div></div>
        <div class="score-item-tag" style="color:${colour(analyse.score_prix)};">${scoreTag(analyse.score_prix)}</div>
      </div>
      <div class="score-item">
        <div class="score-item-label">FIABILITÉ</div>
        <div class="score-item-num" style="color:${colour(analyse.score_fiabilite)};">${analyse.score_fiabilite}</div>
        <div class="score-bar-bg"><div class="score-bar-fill" style="width:${analyse.score_fiabilite*10}%;background:${colour(analyse.score_fiabilite)};"></div></div>
        <div class="score-item-tag" style="color:${colour(analyse.score_fiabilite)};">${scoreTag(analyse.score_fiabilite)}</div>
      </div>
      <div class="score-item">
        <div class="score-item-label">ENTRETIEN</div>
        <div class="score-item-num" style="color:${colour(analyse.score_entretien)};">${analyse.score_entretien}</div>
        <div class="score-bar-bg"><div class="score-bar-fill" style="width:${analyse.score_entretien*10}%;background:${colour(analyse.score_entretien)};"></div></div>
        <div class="score-item-tag" style="color:${colour(analyse.score_entretien)};">${scoreTag(analyse.score_entretien)}</div>
      </div>
    </div>
  </div>

  <div class="grid-4 grid-white">
    <div class="cell"><div class="cell-label">ANNÉE</div><div class="cell-value">${analyse.annee}</div></div>
    <div class="cell"><div class="cell-label">KILOMÉTRAGE</div><div class="cell-value">${analyse.kilometrage} <span class="cell-unit">km</span></div></div>
    <div class="cell"><div class="cell-label">PRIX DEMANDÉ</div><div class="cell-value" style="color:#1a3a6e;">${analyse.prix} <span class="cell-unit">CHF</span></div></div>
    <div class="cell"><div class="cell-label">PUISSANCE</div><div class="cell-value">${analyse.puissance}</div></div>
  </div>

  <div class="grid-4 grid-light" style="border-bottom:1px solid #d0e4f7;">
    <div class="cell"><div class="cell-label">CARBURANT</div><div class="cell-value">${analyse.carburant}</div></div>
    <div class="cell"><div class="cell-label">BOÎTE</div><div class="cell-value">${analyse.boite}</div></div>
    <div class="cell"><div class="cell-label">TRANSMISSION</div><div class="cell-value">${analyse.transmission}</div></div>
    <div class="cell"><div class="cell-label">COULEUR</div><div class="cell-value">${analyse.couleur}</div></div>
  </div>

  <div class="section section-white">
    <div class="section-title"><div class="section-bar" style="background:#1a3a6e;"></div><div class="section-label" style="color:#1a3a6e;">DESCRIPTION VENDEUR</div></div>
    <div class="description-box">${analyse.description_vendeur}</div>
  </div>

  <div class="section section-light">
    <div class="section-title"><div class="section-bar" style="background:#28a745;"></div><div class="section-label" style="color:#28a745;">POINTS CLÉS</div></div>
    <div class="grid-2">
      ${(analyse.points_positifs || []).map(p => `<div class="point-card" style="border-left:3px solid #28a745;">✓ ${p}</div>`).join('')}
      ${(analyse.points_negatifs || []).map(p => `<div class="point-card" style="border-left:3px solid #d4a00a;">⚠ ${p}</div>`).join('')}
    </div>
  </div>

  ${analyse.options?.length > 0 ? `
  <div class="section section-white">
    <div class="section-title"><div class="section-bar" style="background:#1a3a6e;"></div><div class="section-label" style="color:#1a3a6e;">ÉQUIPEMENTS &amp; OPTIONS</div></div>
    <table style="width:100%; border-collapse:separate; border-spacing:0 3px;">
      ${(() => {
        const opts = (analyse.options || []).slice(0, 24);
        const rows = [];
        for (let i = 0; i < opts.length; i += 3) {
          const a = opts[i] || '';
          const b = opts[i+1] || '';
          const c = opts[i+2] || '';
          rows.push(`<tr>
            <td style="width:33%; padding:4px 7px; background:#f0f6ff; font-size:11.5px; color:#0d1b35; border-radius:3px;">⚙ ${a}</td>
            <td style="width:2px;"></td>
            <td style="width:33%; padding:4px 7px; background:${b ? '#f0f6ff' : 'transparent'}; font-size:11.5px; color:#0d1b35; border-radius:3px;">${b ? '⚙ ' + b : ''}</td>
            <td style="width:2px;"></td>
            <td style="width:33%; padding:4px 7px; background:${c ? '#f0f6ff' : 'transparent'}; font-size:11.5px; color:#0d1b35; border-radius:3px;">${c ? '⚙ ' + c : ''}</td>
          </tr>`);
        }
        return rows.join('');
      })()}
    </table>
  </div>` : ''}

  <div class="section section-light">
    <div class="section-title"><div class="section-bar" style="background:#d4a00a;"></div><div class="section-label" style="color:#d4a00a;">COÛTS &amp; MARCHÉ</div></div>
    <div class="costs-grid">
      <div class="cost-card" style="border-top:3px solid #d4a00a;">
        <div class="cost-label">ENTRETIEN AN 1</div>
        <div class="cost-value" style="color:#d4a00a;">${analyse.cout_entretien_annee1?.toLocaleString()} CHF</div>
      </div>
      <div class="cost-card" style="border-top:3px solid #d4a00a;">
        <div class="cost-label">TOTAL 3 ANS</div>
        <div class="cost-value" style="color:#d4a00a;">${analyse.cout_total_3ans?.toLocaleString()} CHF</div>
      </div>
      <div class="cost-card" style="border-top:3px solid #1a3a6e;">
        <div class="cost-label">CO2 &amp; TAXE CANTONALE</div>
        <div class="cost-value" style="color:#1a3a6e;">${analyse.co2 ? analyse.co2 + ' g/km' : 'N/D'}</div>
        <div class="cost-note"><a href="https://www.tcs.ch/fr/tools/calculateurs/impot-vehicule.php" style="color:#1a3a6e;">Calculer ma taxe → tcs.ch</a></div>
      </div>
      <div class="cost-card" style="border-top:3px solid #5a7a9a;">
        <div class="cost-label">FOURCHETTE MARCHÉ</div>
        <div class="cost-value" style="color:#5a7a9a;font-size:12px;">${analyse.fourchette_marche_min?.toLocaleString()} – ${analyse.fourchette_marche_max?.toLocaleString()} CHF</div>
      </div>
    </div>
  </div>

  ${analyse.red_flags?.length > 0 ? `
  <div class="redflag-section">
    <div class="redflag-badge">🚨 RED FLAGS</div>
    ${analyse.red_flags.map(r => `<div class="redflag-card"><div class="redflag-title">✗ ${r}</div></div>`).join('')}
  </div>` : ''}

  ${analyse.problemes_connus_modele?.length > 0 ? `
  <div class="section section-white">
    <div class="section-title"><div class="section-bar" style="background:#d4a00a;"></div><div class="section-label" style="color:#d4a00a;">PROBLÈMES CONNUS DU MODÈLE</div></div>
    ${analyse.problemes_connus_modele.map(p => `<div class="checklist-item-white"><span style="color:#d4a00a;font-weight:700;">⚠</span> ${p}</div>`).join('')}
  </div>` : ''}

  <div class="section section-light">
    <div class="section-title"><div class="section-bar" style="background:#28a745;"></div><div class="section-label" style="color:#28a745;">CHECKLIST VISITE</div></div>
    ${(analyse.checklist_visite || []).map(c => `<div class="checklist-item"><span style="color:#28a745;font-weight:700;">✓</span> ${c}</div>`).join('')}
  </div>

  <div class="section section-white">
    <div class="section-title"><div class="section-bar" style="background:#1a3a6e;"></div><div class="section-label" style="color:#1a3a6e;">QUESTIONS À POSER AU VENDEUR</div></div>
    ${(analyse.questions_vendeur || []).map(q => `<div class="checklist-item-white"><span style="color:#1a3a6e;font-weight:700;">?</span> ${q}</div>`).join('')}
  </div>

  <div class="verdict-section">
    <div>
      <div class="verdict-label">🏆 VERDICT FINAL</div>
      <div class="verdict-value" style="color:${verdictColor[analyse.verdict] || '#d4a00a'};">${analyse.verdict}</div>
      <div class="verdict-desc">${analyse.resume_verdict}</div>
    </div>
    <div style="text-align:right;">
      <div style="font-size:10px;color:#b8d0f0;margin-bottom:4px;">PRIX SUGGÉRÉ</div>
      <div style="font-size:28px;font-weight:900;color:#fff;">${analyse.prix_negocie_suggere?.toLocaleString()} CHF</div>
      <div style="font-size:10px;color:#00B4D8;margin-top:4px;">↓ Économie : ${analyse.economie_potentielle_min?.toLocaleString()} – ${analyse.economie_potentielle_max?.toLocaleString()} CHF</div>
    </div>
  </div>

  <div class="footer">
    Source : ${url}<br>
    Ce rapport est un outil d'aide à la décision. Il ne remplace pas une inspection physique par un professionnel.<br>
    EasyCarCheck · easycarcheck.ch · contact@easycarcheck.ch · 🇨🇭 Suisse
  </div>

</body>
</html>`;

  const pdfResponse = await axios.post('https://api.pdfshift.io/v3/convert/pdf', {
    source: html,
    landscape: false,
    use_print: false,
    format: 'A4',
    margin: { top: '0mm', right: '0mm', bottom: '0mm', left: '0mm' }
  }, {
    headers: {
      'Authorization': `Basic ${Buffer.from(`api:${process.env.PDFSHIFT_API_KEY}`).toString('base64')}`,
      'Content-Type': 'application/json'
    },
    responseType: 'arraybuffer'
  });

  return Buffer.from(pdfResponse.data);
}

// ─── ENVOI EMAIL ─────────────────────────────────────────
async function envoyerEmail(email, pdfBuffer, analyse, reportNumber) {
  const verdictEmailColor = analyse.verdict === 'ACHETER' || analyse.verdict === 'KAUFEN' || analyse.verdict === 'BUY' || analyse.verdict === 'ACQUISTARE' ? '#28a745' : analyse.verdict === 'ÉVITER' || analyse.verdict === 'MEIDEN' || analyse.verdict === 'AVOID' || analyse.verdict === 'EVITARE' ? '#dc3545' : '#d4a00a';
  const scoreEmailColor = analyse.score_global >= 7 ? '#28a745' : analyse.score_global >= 5 ? '#d4a00a' : '#dc3545';

  const result = await resend.emails.send({
    from: 'EasyCarCheck <contact@easycarcheck.ch>',
    to: email,
    subject: `🚗 Votre rapport EasyCarCheck #${reportNumber} — ${analyse.marque} ${analyse.modele}`,
    html: `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f0f6ff;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f6ff;padding:30px 20px;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

  <tr><td style="background:#1a3a6e;border-radius:12px 12px 0 0;padding:24px;text-align:center;">
    <div style="font-size:22px;font-weight:700;color:#fff;letter-spacing:1px;">🚗 EASY<span style="color:#00B4D8;">CAR</span>CHECK</div>
    <div style="font-size:12px;color:#b8d0f0;margin-top:4px;">Analyse IA · Marché Suisse</div>
  </td></tr>

  <tr><td style="background:#fff;padding:32px 28px;border-left:1px solid #d0e4f7;border-right:1px solid #d0e4f7;">

    <div style="text-align:center;margin-bottom:28px;">
      <div style="width:56px;height:56px;background:rgba(40,167,69,0.1);border:2px solid #28a745;border-radius:50%;margin:0 auto 14px;line-height:56px;font-size:26px;text-align:center;">✅</div>
      <h1 style="font-size:22px;font-weight:900;color:#0d1b35;margin:0 0 6px;">Votre rapport est prêt !</h1>
      <p style="font-size:14px;color:#5a7a9a;margin:0;">Il est joint à cet email en pièce jointe PDF.</p>
    </div>

    <div style="background:#f0f6ff;border-radius:10px;padding:18px 20px;margin-bottom:24px;border:1px solid #d0e4f7;">
      <div style="font-size:11px;color:#5a7a9a;letter-spacing:1px;margin-bottom:10px;">VOTRE ANALYSE</div>
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
              <div style="font-size:14px;font-weight:900;color:${verdictEmailColor};">${analyse.verdict}</div>
            </div>
          </td>
          <td width="33%" style="padding-left:6px;">
            <div style="background:#fff;border-radius:8px;padding:10px;text-align:center;border:1px solid #d0e4f7;">
              <div style="font-size:9px;color:#5a7a9a;letter-spacing:1px;margin-bottom:4px;">RAPPORT</div>
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
            <div style="font-size:13px;font-weight:700;color:#0d1b35;">Rapport PDF en pièce jointe</div>
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
    <div style="font-size:12px;color:#b8d0f0;margin-bottom:8px;">EasyCarCheck · easycarcheck.ch · 🇨🇭 Suisse</div>
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
app.get('/', (req, res) => res.json({ status: 'EasyCarCheck Backend OK 🚗' }));

app.post('/test-rapport', async (req, res) => {
  try {
    const { url, email, langue = 'fr' } = req.body;
    if (!url || !email) return res.status(400).json({ error: 'URL et email requis' });
    console.log('1. Démarrage analyse...');
    const reportNumber = String(Math.floor(Math.random() * 900) + 100).padStart(3, '0');
    const scraped = await scrapeAnnonce(url);
    console.log('2. Scraping OK');
    const analyse = await analyserAvecGPT(scraped, langue, url);
    console.log('3. GPT OK - Verdict:', analyse.verdict, '| Score:', analyse.score_global, '| CO2:', analyse.co2, '| Taxe:', analyse.taxe_cantonale_ge);
    const pdf = await genererPDF(analyse, reportNumber, url);
    console.log('4. PDF OK');
    await envoyerEmail(email, pdf, analyse, reportNumber);
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
    const scraped = await scrapeAnnonce(url);
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
      const scraped = await scrapeAnnonce(url);
      const analyse = await analyserAvecGPT(scraped, langue, url);
      const pdf = await genererPDF(analyse, reportNumber, url);
      await envoyerEmail(email, pdf, analyse, reportNumber);
      console.log(`✅ Rapport #${reportNumber} envoyé à ${email}`);
    } catch (err) {
      console.error('Erreur génération rapport:', err);
    }
  }
  res.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚗 EasyCarCheck Backend running on port ${PORT}`));
