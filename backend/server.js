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
    html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    html = html.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '');
    html = html.replace(/<[^>]+>/g, ' ');
    html = html.replace(/\s+/g, ' ').trim();
    console.log('ZENROWS OK:', html.substring(0, 2000));
    return { html: html.substring(0, 20000), url: url };
  } catch (err) {
    console.log('ZENROWS ERROR:', err.response?.data || err.message);
    return { html: `URL: ${url}`, url: url };
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

// ─── ANALYSE GPT-4o ─────────────────────────────────────
async function analyserAvecGPT(scrapedData, langue, url) {
  const langues = { fr: 'français', de: 'allemand', it: 'italien', en: 'anglais' };

  const prompt = `Tu es un expert en analyse de véhicules d'occasion sur le marché suisse.

Voici le contenu de l'annonce automobile :
URL: ${url}
Contenu: ${scrapedData.html}

ÉTAPE 1 - Extrais ces données EXACTES depuis le contenu :
- Prix exact en CHF (nombre entier)
- Kilométrage exact (nombre entier)
- Année exacte
- Marque et modèle exacts
- Carburant (Essence / Diesel / Électrique / Hybride)
- Boîte de vitesses
- Puissance en PS uniquement (ex: "306 PS")
- CO2 en g/km si disponible (nombre entier, sinon null)
- Couleur exacte — cherche PARTOUT dans la page (titre, description, caractéristiques, "Denim Blue", "Noir", etc). Si introuvable, mets "Non communiquée"
- Transmission (2 roues motrices / 4 roues motrices)
- Description complète du vendeur
- TOUTES les options et équipements listés — inclure les packs et leurs contenus, supprimer les doublons, traduire tout en ${langues[langue] || 'français'}, supprimer les mentions "Détails consultez la liste de prix" et "Details siehe Preisliste"

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
- score_global = ENTIER arrondi (jamais décimal)
- taxe_cantonale_ge = mettre 0 (calculé automatiquement par le système)

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
4. score_global = entier arrondi
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

  // Force scores entiers
  parsed.score_global = Math.round(parsed.score_global || 0);
  parsed.score_prix = Math.round(parsed.score_prix || 0);
  parsed.score_fiabilite = Math.round(parsed.score_fiabilite || 0);
  parsed.score_entretien = Math.round(parsed.score_entretien || 0);

  // Si culasse remplacée → score max 6
  const culasseDetectee = (parsed.red_flags || []).some(r => r.toLowerCase().includes('culasse')) ||
    (parsed.points_negatifs || []).some(p => p.toLowerCase().includes('culasse'));
  if (culasseDetectee && parsed.score_global > 6) parsed.score_global = 6;
  if (culasseDetectee && parsed.score_fiabilite > 5) parsed.score_fiabilite = 5;

  // Calcul taxe estimation
  parsed.taxe_cantonale_ge = estimerTaxe(parsed.co2, parsed.carburant);

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
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; background: #f0f6ff; color: #0d1b35; font-size: 13px; }
  .header { background: linear-gradient(135deg, #1a3a6e, #2952a3); padding: 18px 22px; border-bottom: 2px solid #00B4D8; page-break-inside: avoid; }
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
  .scores-bar { padding: 11px 22px; background: #fff; border-bottom: 1px solid #d0e4f7; page-break-inside: avoid; }
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
  .section { padding: 12px 22px; border-bottom: 1px solid #d0e4f7; page-break-inside: avoid; }
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
  .checklist-item { background: #f0f6ff; border-radius: 5px; padding: 7px 10px; font-size: 12px; color: #0d1b35; display: flex; align-items: center; gap: 7px; margin-bottom: 4px; }
  .checklist-item-white { background: #fff; border-radius: 5px; padding: 7px 10px; font-size: 12px; color: #0d1b35; display: flex; align-items: center; gap: 7px; margin-bottom: 4px; }
  .costs-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; page-break-inside: avoid; }
  .cost-card { background: #fff; border-radius: 7px; padding: 11px; text-align: center; }
  .cost-label { font-size: 9px; color: #5a7a9a; letter-spacing: 1px; margin-bottom: 5px; }
  .cost-value { font-size: 15px; font-weight: 800; }
  .cost-note { font-size: 8px; color: #5a7a9a; margin-top: 3px; }
  .redflag-section { padding: 12px 22px; background: rgba(220,53,69,0.04); border-bottom: 2px solid #dc3545; page-break-inside: avoid; }
  .redflag-badge { background: #dc3545; border-radius: 4px; padding: 3px 10px; font-size: 10px; font-weight: 700; color: #fff; display: inline-block; margin-bottom: 8px; }
  .redflag-card { background: rgba(220,53,69,0.06); border-radius: 7px; padding: 10px; border: 1px solid rgba(220,53,69,0.2); margin-bottom: 5px; }
  .redflag-title { font-size: 12px; font-weight: 600; color: #dc3545; }
  .verdict-section { padding: 18px 22px; display: flex; justify-content: space-between; align-items: center; background: linear-gradient(135deg, #1a3a6e, #2952a3); page-break-inside: avoid; }
  .verdict-label { font-size: 10px; color: #b8d0f0; letter-spacing: 2px; margin-bottom: 5px; }
  .verdict-value { font-size: 30px; font-weight: 900; letter-spacing: 2px; }
  .verdict-desc { font-size: 11px; color: #b8d0f0; margin-top: 6px; max-width: 280px; line-height: 1.5; }
  .footer { padding: 10px 22px; background: #f0f6ff; border-top: 1px solid #d0e4f7; font-size: 9px; color: #5a7a9a; text-align: center; line-height: 1.6; page-break-inside: avoid; page-break-before: avoid; }
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
    <div class="grid-3">
      ${analyse.options.map(o => `<div class="point-card-light">⚙ ${o}</div>`).join('')}
    </div>
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
        <div class="cost-label">TAXE CANTONALE EST.</div>
        <div class="cost-value" style="color:#1a3a6e;">~${analyse.taxe_cantonale_ge?.toLocaleString()} CHF/an</div>
        <div class="cost-note">Estimation · varie selon canton</div>
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
    use_print: false
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
  const result = await resend.emails.send({
    from: 'EasyCarCheck <contact@easycarcheck.ch>',
    to: email,
    subject: `🚗 Votre rapport EasyCarCheck #${reportNumber} — ${analyse.marque} ${analyse.modele}`,
    html: `
      <div style="font-family:Arial;background:#1a3a6e;color:#fff;padding:30px;border-radius:10px;">
        <h1 style="color:#00B4D8;">🚗 EasyCarCheck</h1>
        <p>Votre rapport d'analyse est prêt !</p>
        <h2>${analyse.marque} ${analyse.modele} ${analyse.annee}</h2>
        <p>Verdict : <strong style="color:${analyse.verdict === 'ACHETER' ? '#28a745' : analyse.verdict === 'ÉVITER' ? '#dc3545' : '#d4a00a'}">${analyse.verdict}</strong></p>
        <p>Score global : <strong>${analyse.score_global}/10</strong></p>
        <p style="color:#b8d0f0;font-size:12px;">Le rapport PDF complet est en pièce jointe.</p>
        <p style="color:#b8d0f0;font-size:11px;">EasyCarCheck · easycarcheck.ch</p>
      </div>
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
    console.log('3. GPT OK - Verdict:', analyse.verdict, '| Score:', analyse.score_global, '| Taxe:', analyse.taxe_cantonale_ge);
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
