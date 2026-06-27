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

async function scrapeAnnonce(url) {
  try {
    const response = await axios.get('https://api.zenrows.com/v1/', {
      params: {
        apikey: process.env.ZENROWS_API_KEY,
        url: url,
        js_render: 'true',
        premium_proxy: 'true',
        wait: '5000'
      },
      timeout: 90000
    });
    let html = response.data;
    if (typeof html !== 'string') html = JSON.stringify(html);
    html = html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    html = html.replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '');
    html = html.replace(/<[^>]+>/g, ' ');
    html = html.replace(/\s+/g, ' ').trim();
    console.log('ZENROWS OK:', html.substring(0, 2000));
    return { html: html.substring(0, 15000), url: url };
  } catch (err) {
    console.log('ZENROWS ERROR:', err.response?.data || err.message);
    return { html: `URL: ${url}`, url: url };
  }
}

// ─── CALCUL TAXE GE ─────────────────────────────────────
function calculerTaxeGE(co2, poids, carburant) {
  const base = 120;

  // Véhicule électrique
  if (carburant && carburant.toLowerCase().includes('électr')) {
    let surtaxe = 0;
    if (!poids) return base + 500; // poids inconnu
    if (poids <= 1400) surtaxe = 0;
    else if (poids <= 1650) surtaxe = 50;
    else if (poids <= 1750) surtaxe = 100;
    else if (poids <= 1900) surtaxe = 200;
    else if (poids <= 2100) surtaxe = 400;
    else if (poids <= 2300) surtaxe = 600;
    else if (poids <= 2400) surtaxe = 800;
    else if (poids <= 2500) surtaxe = 1100;
    else if (poids <= 2600) surtaxe = 1200;
    else surtaxe = 1400;
    return base + surtaxe;
  }

  // Véhicule thermique ou hybride
  if (!co2) return base + 500; // CO2 inconnu → forfait
  let tauxParG = 0;
  if (co2 <= 120) tauxParG = 0.25;
  else if (co2 <= 135) tauxParG = 0.75;
  else if (co2 <= 155) tauxParG = 1.25;
  else if (co2 <= 175) tauxParG = 2.25;
  else if (co2 <= 200) tauxParG = 3.50;
  else if (co2 <= 250) tauxParG = 4.50;
  else if (co2 <= 300) tauxParG = 8.00;
  else tauxParG = 12.00;
  return Math.round(base + (co2 * tauxParG));
}

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
- Carburant, boîte, puissance
- CO2 en g/km si disponible (nombre entier, sinon null)
- Poids à vide en kg si disponible (nombre entier, sinon null)
- Couleur exacte — cherche dans toute la page. Si introuvable, mets "Non communiquée"
- Description complète du vendeur
- Toutes les options listées

ÉTAPE 2 - Analyse approfondie :
- Compare le prix avec le marché suisse actuel et calcule fourchette marché min et max réaliste
- Pour Mercedes A35 AMG : problème culasse moteur M260 récurrent (remplacement 5000-8000 CHF hors garantie), boîte DCT fragile
- DÉTECTION CULASSE : Si "Zylinderkopf" ou "culasse" ou "cylindre" mentionné dans l'annonce → ajouter "Culasse remplacée" dans red_flags ET dans points_negatifs. JAMAIS dans points_positifs. Toujours "Culasse remplacée" comme terme exact
- Si culasse remplacée détectée → baisser score_fiabilite de 2 points
- INTERDITS comme points négatifs : "consommation de carburant élevée", "consommation d'huile élevée", kilométrage normal (<25000 km/an)
- KILOMÉTRAGE : qualifier d'élevé SEULEMENT si >25000 km/an. 54500 km en 2021 = ~13000 km/an = NORMAL, ne pas mentionner
- FREE SERVICE : Si service gratuit Mercedes actif → cout_entretien_annee1 = 250 CHF, cout_total_3ans = 750 CHF. Ajouter dans points_positifs "Entretien main d'oeuvre et pièces couvert par Mercedes (liquides à la charge du propriétaire)"
- BOÎTE : "Manuelle robotisée" sur AutoScout24 = "Automatique (DCT)" pour Mercedes AMG
- DESCRIPTION : Traduire INTÉGRALEMENT en ${langues[langue] || 'français'} en phrases claires et lisibles. Jamais de liste de mots-clés bruts
- Ne jamais inventer des points négatifs absents de l'annonce
- taxe_cantonale_ge : mettre 0 (sera calculé automatiquement)
- score_global doit être un ENTIER (arrondi), jamais un décimal comme 6.7

QUANTITÉS OBLIGATOIRES :
- points_positifs : minimum 3 éléments
- points_negatifs : minimum 2 éléments (uniquement si réels)
- checklist_visite : exactement 4 éléments
- questions_vendeur : exactement 3 questions
- problemes_connus_modele : 2 à 3 éléments

ÉTAPE 3 - Génère le rapport en ${langues[langue] || 'français'}.

RÈGLES JSON ABSOLUES :
1. Réponds UNIQUEMENT avec du JSON valide, rien d'autre
2. verdict = UNIQUEMENT "ACHETER", "NÉGOCIER" ou "ÉVITER"
3. prix_negocie_suggere = nombre réaliste, jamais 0
4. Guillemets doubles uniquement
5. Pas de virgule après le dernier élément
6. score_global = entier arrondi (ex: 6 pas 6.7)
7. taxe_cantonale_ge entre 400 et 1200, JAMAIS 0

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
  "poids": null,
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

  // Force score_global entier
  if (parsed.score_global) parsed.score_global = Math.round(parsed.score_global);
  if (parsed.score_prix) parsed.score_prix = Math.round(parsed.score_prix);
  if (parsed.score_fiabilite) parsed.score_fiabilite = Math.round(parsed.score_fiabilite);
  if (parsed.score_entretien) parsed.score_entretien = Math.round(parsed.score_entretien);
  // Calcul taxe GE précis selon barème officiel genevois 2025
  parsed.taxe_cantonale_ge = calculerTaxeGE(parsed.co2, parsed.poids, parsed.carburant);

  return parsed;
}

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
  body { font-family: Arial, sans-serif; background: #f0f6ff; color: #0d1b35; }
  .header { background: linear-gradient(135deg, #1a3a6e, #2952a3); padding: 24px; border-bottom: 2px solid #00B4D8; page-break-inside: avoid; }
  .header-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
  .logo { font-size: 20px; font-weight: 700; letter-spacing: 2px; color: #fff; }
  .logo span { color: #00B4D8; }
  .report-num { font-size: 11px; color: #b8d0f0; }
  .header-main { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
  .car-brand-label { font-size: 11px; color: #b8d0f0; letter-spacing: 3px; margin-bottom: 4px; }
  .car-brand { font-size: 28px; font-weight: 900; letter-spacing: 2px; line-height: 1.1; color: #fff; }
  .car-model { font-size: 18px; color: #00B4D8; font-weight: 700; margin-top: 4px; }
  .score-box { display: flex; flex-direction: column; align-items: center; background: rgba(255,255,255,0.1); border-radius: 12px; padding: 16px 20px; min-width: 110px; }
  .score-label { font-size: 9px; color: #b8d0f0; letter-spacing: 2px; margin-bottom: 4px; }
  .score-num { font-size: 52px; font-weight: 900; line-height: 1; }
  .score-denom { font-size: 12px; color: #b8d0f0; }
  .score-badge { margin-top: 6px; border-radius: 4px; padding: 2px 8px; font-size: 10px; font-weight: 700; color: #000; }
  .scores-bar { padding: 16px 20px; background: #fff; border-bottom: 1px solid #d0e4f7; page-break-inside: avoid; }
  .scores-bar-title { font-size: 10px; color: #5a7a9a; letter-spacing: 1px; margin-bottom: 14px; }
  .scores-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  .score-item { text-align: center; }
  .score-item-label { font-size: 10px; color: #5a7a9a; letter-spacing: 1px; margin-bottom: 4px; }
  .score-item-num { font-size: 46px; font-weight: 900; line-height: 1; margin-bottom: 6px; }
  .score-bar-bg { height: 8px; background: #d0e4f7; border-radius: 4px; }
  .score-bar-fill { height: 8px; border-radius: 4px; }
  .score-item-tag { font-size: 10px; font-weight: 700; margin-top: 4px; }
  .grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); border-bottom: 1px solid #d0e4f7; page-break-inside: avoid; }
  .cell { padding: 14px; border-right: 1px solid #d0e4f7; }
  .cell:last-child { border-right: none; }
  .cell-label { font-size: 10px; color: #5a7a9a; letter-spacing: 1px; margin-bottom: 4px; text-transform: uppercase; }
  .cell-value { font-size: 15px; font-weight: 700; color: #0d1b35; }
  .grid-white { background: #fff; }
  .grid-light { background: #f0f6ff; }
  .section { padding: 20px; border-bottom: 1px solid #d0e4f7; page-break-inside: avoid; }
  .section-white { background: #fff; }
  .section-light { background: #f0f6ff; }
  .section-title { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
  .section-bar { width: 4px; height: 18px; border-radius: 2px; flex-shrink: 0; }
  .section-label { font-size: 13px; font-weight: 700; letter-spacing: 1px; }
  .description-box { background: #f0f6ff; border-radius: 8px; padding: 14px; font-size: 13px; color: #3a5a7a; line-height: 1.6; border-left: 3px solid #1a3a6e; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .point-card { background: #fff; border-radius: 6px; padding: 9px 12px; font-size: 13px; color: #0d1b35; }
  .point-card-light { background: #f0f6ff; border-radius: 6px; padding: 9px 12px; font-size: 13px; color: #0d1b35; }
  .checklist-item { background: #f0f6ff; border-radius: 6px; padding: 11px 14px; font-size: 13px; color: #0d1b35; display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .checklist-item-white { background: #fff; border-radius: 6px; padding: 11px 14px; font-size: 13px; color: #0d1b35; display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .costs-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; page-break-inside: avoid; }
  .cost-card { background: #fff; border-radius: 8px; padding: 14px; text-align: center; }
  .cost-label { font-size: 10px; color: #5a7a9a; letter-spacing: 1px; margin-bottom: 6px; }
  .cost-value { font-size: 16px; font-weight: 800; }
  .redflag-section { padding: 20px; background: rgba(220,53,69,0.04); border-bottom: 2px solid #dc3545; page-break-inside: avoid; }
  .redflag-badge { background: #dc3545; border-radius: 4px; padding: 3px 10px; font-size: 10px; font-weight: 700; color: #fff; display: inline-block; margin-bottom: 10px; }
  .redflag-card { background: rgba(220,53,69,0.06); border-radius: 8px; padding: 12px; border: 1px solid rgba(220,53,69,0.2); margin-bottom: 6px; }
  .redflag-title { font-size: 13px; font-weight: 600; color: #dc3545; }
  .verdict-section { padding: 24px; display: flex; justify-content: space-between; align-items: center; background: linear-gradient(135deg, #1a3a6e, #2952a3); page-break-inside: avoid; }
  .verdict-label { font-size: 10px; color: #b8d0f0; letter-spacing: 2px; margin-bottom: 6px; }
  .verdict-value { font-size: 32px; font-weight: 900; letter-spacing: 2px; }
  .verdict-desc { font-size: 12px; color: #b8d0f0; margin-top: 8px; max-width: 300px; line-height: 1.5; }
  .footer { padding: 14px 20px; background: #f0f6ff; border-top: 1px solid #d0e4f7; font-size: 9px; color: #5a7a9a; text-align: center; line-height: 1.6; page-break-inside: avoid; }
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
    <div class="cell"><div class="cell-label">KILOMÉTRAGE</div><div class="cell-value">${analyse.kilometrage} <span style="font-size:10px;color:#5a7a9a;">km</span></div></div>
    <div class="cell"><div class="cell-label">PRIX DEMANDÉ</div><div class="cell-value" style="color:#1a3a6e;">${analyse.prix} <span style="font-size:10px;">CHF</span></div></div>
    <div class="cell"><div class="cell-label">PUISSANCE</div><div class="cell-value">${analyse.puissance} <span style="font-size:10px;color:#5a7a9a;">PS</span></div></div>
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
  <div class="section section-white" style="page-break-after: avoid;">
    <div class="section-title"><div class="section-bar" style="background:#1a3a6e;"></div><div class="section-label" style="color:#1a3a6e;">ÉQUIPEMENTS &amp; OPTIONS</div></div>
    <div class="grid-2">
      ${analyse.options.map(o => `<div class="point-card-light">⚙ ${o}</div>`).join('')}
    </div>
  </div>` : ''}

  <div class="section section-light" style="page-break-before: always;">
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
        <div class="cost-label">TAXE GE / AN</div>
        <div class="cost-value" style="color:#1a3a6e;">${analyse.taxe_cantonale_ge?.toLocaleString()} CHF</div>
        <div style="font-size:9px;color:#5a7a9a;margin-top:4px;">ge.ch/calcul-taxe-vehicule</div>
      </div>
      <div class="cost-card" style="border-top:3px solid #5a7a9a;">
        <div class="cost-label">FOURCHETTE MARCHÉ</div>
        <div class="cost-value" style="color:#5a7a9a;font-size:13px;">${analyse.fourchette_marche_min?.toLocaleString()} – ${analyse.fourchette_marche_max?.toLocaleString()} CHF</div>
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
      <div style="font-size:30px;font-weight:900;color:#fff;">${analyse.prix_negocie_suggere?.toLocaleString()} CHF</div>
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
    console.log('3. GPT OK - Verdict:', analyse.verdict, '| Score:', analyse.score_global);
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
