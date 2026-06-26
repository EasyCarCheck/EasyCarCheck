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

// ─── ANALYSE GPT-4o ─────────────────────────────────────
async function analyserAvecGPT(scrapedData, langue, url) {
  const langues = { fr: 'français', de: 'allemand', it: 'italien', en: 'anglais' };

  const prompt = `Tu es un expert en analyse de véhicules d'occasion sur le marché suisse.

Voici le contenu de l'annonce automobile :
URL: ${url}
Contenu: ${scrapedData.html}

ÉTAPE 1 - Extrais ces données exactes depuis le contenu :
- Prix exact en CHF
- Kilométrage exact
- Année exacte
- Marque et modèle exacts
- Carburant, boîte, puissance
- Couleur exacte du véhicule — cherche dans toute la page (titre, description, caractéristiques). Si introuvable, mets "Non communiquée"
- Description du vendeur
- Options listées

ÉTAPE 2 - Analyse approfondie :
- Compare le prix avec le marché suisse actuel et calcule TOUJOURS une fourchette marché min et max réaliste
- Identifie TOUS les problèmes connus de ce modèle
- Pour Mercedes A35 AMG : problème culasse moteur M260 récurrent, remplacement 5000-8000 CHF hors garantie, boîte DCT fragile
- Détecte les red flags dans la description vendeur
- Si "Zylinderkopf" mentionné → red flag majeur : "Culasse remplacée" (traduis TOUJOURS en français)
- Traduis INTÉGRALEMENT la description du vendeur en ${langues[langue] || 'français'}, mot par mot, sans laisser aucun mot en allemand ou italien
- La description vendeur doit être rédigée en phrases claires et lisibles, PAS en liste de mots-clés bruts. Reformule si nécessaire pour que ce soit lisible et professionnel.
- Traduis TOUS les termes techniques allemands ou italiens en français dans le rapport
- Pour évaluer le kilométrage : kilométrage NORMAL = moins de 20000 km/an. Ne qualifier de "élevé" que si plus de 25000 km/an
- La boîte "Manuelle robotisée" sur AutoScout24 = toujours traduire en "Automatique (DCT)" pour les Mercedes AMG
- Extrais OBLIGATOIREMENT : couleur, transmission (2 ou 4 roues motrices), liste complète des options, description exacte du vendeur traduite
- Estime le coût entretien année 1 et total sur 3 ans
- Génère TOUJOURS au minimum 4 points positifs/négatifs combinés dans points_positifs et points_negatifs
- Génère TOUJOURS exactement 4 éléments dans checklist_visite, pas plus
- Génère TOUJOURS exactement 3 questions dans questions_vendeur, pas plus
- Génère TOUJOURS au minimum 2 problèmes connus dans problemes_connus_modele, pas plus de 3
- La taxe cantonale genevoise dépend du CO2 du véhicule. Estime TOUJOURS un montant réaliste entre 400 et 1200 CHF/an, JAMAIS 0

ÉTAPE 3 - Génère le rapport en ${langues[langue] || 'français'}.

RÈGLES ABSOLUES :
1. Réponds UNIQUEMENT avec du JSON valide sans apostrophes dans les chaînes
2. Le champ verdict = UNIQUEMENT ACHETER, NÉGOCIER ou ÉVITER
3. prix_negocie_suggere doit être un nombre réaliste jamais 0
4. Utilise uniquement des guillemets doubles dans le JSON
5. Pas de virgule après le dernier élément d'un tableau ou objet
6. Traduis TOUJOURS tout en ${langues[langue] || 'français'}, aucun mot en allemand ou italien
7. taxe_cantonale_ge doit TOUJOURS être un nombre entre 400 et 1200, JAMAIS 0
8. fourchette_marche_min et fourchette_marche_max doivent TOUJOURS être des nombres réalistes

{
  "marque": "",
  "modele": "",
  "annee": "",
  "kilometrage": "",
  "prix": "",
  "carburant": "",
  "boite": "",
  "puissance": "",
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

  try {
    return JSON.parse(clean);
  } catch(e) {
    clean = clean.replace(/,(\s*[}\]])/g, '$1');
    clean = clean.replace(/[\u2018\u2019]/g, '');
    try {
      return JSON.parse(clean);
    } catch(e2) {
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) {
        try { return JSON.parse(match[0]); } catch(e3) { throw new Error('JSON invalide'); }
      }
      throw new Error('JSON invalide');
    }
  }
}

// ─── GÉNÉRATION PDF ──────────────────────────────────────
async function genererPDF(analyse, reportNumber, url) {
  const verdictColor = {
    'ACHETER': '#28a745', 'NÉGOCIER': '#d4a00a', 'ÉVITER': '#dc3545',
    'VERHANDELN': '#d4a00a', 'KAUFEN': '#28a745', 'MEIDEN': '#dc3545',
    'NEGOTIATE': '#d4a00a', 'BUY': '#28a745', 'AVOID': '#dc3545',
    'ACQUISTARE': '#28a745', 'TRATTARE': '#d4a00a', 'EVITARE': '#dc3545'
  };
  const colour = (score) => score >= 8 ? '#28a745' : score >= 5 ? '#d4a00a' : '#dc3545';
  const badge = (score) => score >= 8 ? 'EXCELLENT' : score >= 5 ? 'MOYEN' : 'À ÉVITER';

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; background: #f0f6ff; color: #0d1b35; }
  .page { padding: 0; }
  .header { background: linear-gradient(135deg, #1a3a6e, #2952a3); padding: 24px; border-bottom: 2px solid #00B4D8; }
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
  .scores-bar { padding: 14px 20px; background: #fff; border-bottom: 1px solid #d0e4f7; }
  .scores-bar-title { font-size: 10px; color: #5a7a9a; letter-spacing: 1px; margin-bottom: 10px; }
  .scores-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
  .score-item { text-align: center; }
  .score-item-label { font-size: 9px; color: #5a7a9a; margin-bottom: 4px; }
  .score-item-num { font-size: 22px; font-weight: 800; }
  .score-bar-bg { height: 4px; background: #d0e4f7; border-radius: 2px; margin-top: 4px; }
  .score-bar-fill { height: 4px; border-radius: 2px; }
  .grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); border-bottom: 1px solid #d0e4f7; }
  .cell { padding: 14px; border-right: 1px solid #d0e4f7; }
  .cell:last-child { border-right: none; }
  .cell-label { font-size: 11px; color: #5a7a9a; letter-spacing: 1px; margin-bottom: 4px; text-transform: uppercase; }
  .cell-value { font-size: 15px; font-weight: 700; color: #0d1b35; }
  .cell-value-sm { font-size: 15px; font-weight: 700; color: #0d1b35; }
  .grid-white { background: #fff; }
  .grid-light { background: #f0f6ff; }
  .section { padding: 20px; border-bottom: 1px solid #d0e4f7; page-break-inside: avoid; }
  .section-white { background: #fff; }
  .section-light { background: #f0f6ff; }
  .section-title { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; }
  .section-bar { width: 4px; height: 18px; border-radius: 2px; flex-shrink: 0; }
  .section-label { font-size: 14px; font-weight: 700; letter-spacing: 1px; }
  .description-box { background: #f0f6ff; border-radius: 8px; padding: 12px; font-size: 13px; color: #3a5a7a; line-height: 1.6; border-left: 3px solid #1a3a6e; }
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .point-card { background: #fff; border-radius: 6px; padding: 8px 12px; font-size: 13px; color: #0d1b35; }
  .point-card-light { background: #f0f6ff; border-radius: 6px; padding: 8px 12px; font-size: 13px; color: #0d1b35; }
  .checklist-item { background: #f0f6ff; border-radius: 6px; padding: 10px 14px; font-size: 13px; color: #0d1b35; display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .checklist-item-white { background: #fff; border-radius: 6px; padding: 10px 14px; font-size: 13px; color: #0d1b35; display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .costs-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; page-break-inside: avoid; }
  .cost-card { background: #fff; border-radius: 8px; padding: 14px; text-align: center; page-break-inside: avoid; }
  .cost-label { font-size: 9px; color: #5a7a9a; letter-spacing: 1px; margin-bottom: 6px; }
  .cost-value { font-size: 16px; font-weight: 800; }
  .redflag-section { padding: 20px; background: rgba(220,53,69,0.04); border-bottom: 2px solid #dc3545; page-break-inside: avoid; }
  .redflag-badge { background: #dc3545; border-radius: 4px; padding: 3px 10px; font-size: 10px; font-weight: 700; color: #fff; display: inline-block; margin-bottom: 10px; }
  .redflag-card { background: rgba(220,53,69,0.06); border-radius: 8px; padding: 12px; border: 1px solid rgba(220,53,69,0.2); margin-bottom: 6px; }
  .redflag-title { font-size: 12px; font-weight: 600; color: #dc3545; margin-bottom: 4px; }
  .redflag-desc { font-size: 11px; color: #5a7a9a; }
  .verdict-section { padding: 20px; display: flex; justify-content: space-between; align-items: center; background: linear-gradient(135deg, #1a3a6e, #2952a3); }
  .verdict-label { font-size: 10px; color: #b8d0f0; letter-spacing: 2px; margin-bottom: 6px; }
  .verdict-value { font-size: 30px; font-weight: 900; letter-spacing: 2px; }
  .verdict-desc { font-size: 11px; color: #b8d0f0; margin-top: 6px; max-width: 300px; line-height: 1.5; }
  .footer { padding: 14px 20px; background: #f0f6ff; border-top: 1px solid #d0e4f7; font-size: 9px; color: #5a7a9a; text-align: center; line-height: 1.6; }
</style>
</head>
<body>
<div class="page">

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
        <div class="score-item-num" style="color: ${colour(analyse.score_prix)};">${analyse.score_prix}</div>
        <div class="score-bar-bg"><div class="score-bar-fill" style="width: ${analyse.score_prix * 10}%; background: ${colour(analyse.score_prix)};"></div></div>
      </div>
      <div class="score-item">
        <div class="score-item-label">FIABILITÉ</div>
        <div class="score-item-num" style="color: ${colour(analyse.score_fiabilite)};">${analyse.score_fiabilite}</div>
        <div class="score-bar-bg"><div class="score-bar-fill" style="width: ${analyse.score_fiabilite * 10}%; background: ${colour(analyse.score_fiabilite)};"></div></div>
      </div>
      <div class="score-item">
        <div class="score-item-label">ENTRETIEN</div>
        <div class="score-item-num" style="color: ${colour(analyse.score_entretien)};">${analyse.score_entretien}</div>
        <div class="score-bar-bg"><div class="score-bar-fill" style="width: ${analyse.score_entretien * 10}%; background: ${colour(analyse.score_entretien)};"></div></div>
      </div>
    </div>
  </div>

  <div class="grid-4 grid-white">
    <div class="cell"><div class="cell-label">ANNÉE</div><div class="cell-value">${analyse.annee}</div></div>
    <div class="cell"><div class="cell-label">KILOMÉTRAGE</div><div class="cell-value">${analyse.kilometrage} <span style="font-size:10px;color:#5a7a9a;">km</span></div></div>
    <div class="cell"><div class="cell-label">PRIX DEMANDÉ</div><div class="cell-value" style="color:#1a3a6e;">${analyse.prix} <span style="font-size:10px;">CHF</span></div></div>
    <div class="cell"><div class="cell-label">PUISSANCE</div><div class="cell-value">${analyse.puissance} <span style="font-size:10px;color:#5a7a9a;">PS</span></div></div>
  </div>

  <div class="grid-4 grid-light" style="border-bottom: 1px solid #d0e4f7;">
    <div class="cell"><div class="cell-label">CARBURANT</div><div class="cell-value-sm">${analyse.carburant}</div></div>
    <div class="cell"><div class="cell-label">BOÎTE</div><div class="cell-value-sm">${analyse.boite}</div></div>
    <div class="cell"><div class="cell-label">TRANSMISSION</div><div class="cell-value-sm">${analyse.transmission}</div></div>
    <div class="cell"><div class="cell-label">COULEUR</div><div class="cell-value-sm">${analyse.couleur}</div></div>
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
    <div class="grid-2">
      ${analyse.options.map(o => `<div class="point-card-light">⚙ ${o}</div>`).join('')}
    </div>
  </div>` : ''}

  <div class="section section-light" style="page-break-before: always; page-break-inside: avoid;">
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
    ${analyse.red_flags.map(r => `
    <div class="redflag-card">
      <div class="redflag-title">✗ ${r}</div>
    </div>`).join('')}
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
        <p>Verdict : <strong style="color:${analyse.verdict === 'ACHETER' ? '#28a745' : analyse.verdict === 'ÉVITER' ? '#dc3545' : '#ffc107'}">${analyse.verdict}</strong></p>
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
    console.log('3. GPT OK - Verdict:', analyse.verdict);
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
