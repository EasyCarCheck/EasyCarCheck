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
    const response = await axios.get('https://app.scrapingbee.com/api/v1', {
      params: {
        api_key: process.env.SCRAPINGBEE_API_KEY,
        url: url,
        render_js: true,
        premium_proxy: true,
        country_code: 'ch'
      },
      timeout: 60000
    });
    console.log('SCRAPING OK:', JSON.stringify(response.data).substring(0, 500));
    return response.data;
  } catch (err) {
    console.log('SCRAPING ERROR:', err.message);
    return { url: url, error: err.message };
  }
}
// ─── ANALYSE GPT-4o ─────────────────────────────────────
async function analyserAvecGPT(scrapedData, langue, url) {
  const langues = { fr: 'français', de: 'allemand', it: 'italien', en: 'anglais' };

  const prompt = `Tu es un expert en analyse de véhicules d'occasion sur le marché suisse.

URL de l'annonce : ${url}

Analyse ce véhicule en te basant sur l'URL et tes connaissances du marché suisse.
Génère le rapport en ${langues[langue] || 'français'}.

RÈGLE ABSOLUE : Réponds UNIQUEMENT avec du JSON valide, sans aucun texte avant ou après, sans commentaires, sans apostrophes dans les clés.

{
  "marque": "Mercedes-Benz",
  "modele": "A 35 AMG",
  "annee": "2021",
  "kilometrage": "54500 km",
  "prix": "34900 CHF",
  "carburant": "Essence",
  "boite": "Automatique",
  "puissance": "306 ch",
  "couleur": "Bleu",
  "options": ["4Matic", "Speedshift"],
  "description_vendeur": "",
  "score_prix": 6,
  "score_fiabilite": 5,
  "score_entretien": 6,
  "score_global": 6,
  "verdict": "NÉGOCIER",
  "economie_potentielle_min": 1500,
  "economie_potentielle_max": 3000,
  "prix_negocie_suggere": 32000,
  "fourchette_marche_min": 30000,
  "fourchette_marche_max": 34000,
  "points_positifs": ["Faible kilométrage", "Véhicule suisse"],
  "points_negatifs": ["Prix surévalué", "Consommation élevée"],
  "red_flags": ["Culasse remplacée mentionnée dans l annonce"],
  "problemes_connus_modele": ["Problème culasse moteur M260 récurrent", "Boîte DCT fragile"],
  "checklist_visite": ["Vérifier historique culasse", "Tester la boîte DCT"],
  "questions_vendeur": ["Pourquoi vendez-vous?", "Y a-t-il eu d autres réparations?"],
  "cout_entretien_annee1": 1200,
  "cout_total_3ans": 38500,
  "taxe_cantonale_ge": 1065,
  "resume_verdict": "Véhicule intéressant mais prix surévalué et historique de culasse préoccupant."
}

Remplace les valeurs par celles correspondant au véhicule de l'URL. JSON uniquement, rien d'autre.`;

  const response = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 2000
  }, {
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  const content = response.data.choices[0].message.content;
  const clean = content.replace(/```json|```/g, '').trim();
  console.log('GPT RESPONSE:', clean.substring(0, 1000));
  try {
    return JSON.parse(clean);
  } catch(e) {
    const match = clean.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('JSON invalide');
  }
}
// ─── GÉNÉRATION PDF ──────────────────────────────────────
async function genererPDF(analyse, reportNumber, url) {
  const verdictColor = {
    'ACHETER': '#28a745', 'NÉGOCIER': '#ffc107', 'ÉVITER': '#dc3545',
    'VERHANDELN': '#ffc107', 'KAUFEN': '#28a745', 'MEIDEN': '#dc3545',
    'NEGOTIATE': '#ffc107', 'BUY': '#28a745', 'AVOID': '#dc3545',
    'ACQUISTARE': '#28a745', 'TRATTARE': '#ffc107', 'EVITARE': '#dc3545'
  };
  const color = verdictColor[analyse.verdict] || '#ffc107';

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: Arial, sans-serif; background: #0D1B2A; color: #fff; }
  .page { padding: 40px; min-height: 297mm; }
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 30px; }
  .logo { font-size: 24px; font-weight: bold; color: #fff; }
  .logo span { color: #00B4D8; }
  .report-num { color: #aaa; font-size: 12px; }
  .title { font-size: 48px; font-weight: bold; margin-bottom: 5px; }
  .subtitle { color: #00B4D8; font-size: 32px; font-weight: bold; margin-bottom: 30px; }
  .grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px; margin-bottom: 30px; }
  .card { background: #1A3A5C; border-radius: 8px; padding: 15px; }
  .card-label { font-size: 10px; color: #aaa; text-transform: uppercase; margin-bottom: 5px; }
  .card-value { font-size: 18px; font-weight: bold; }
  .verdict-box { background: #1A3A5C; border-radius: 8px; padding: 20px; margin-bottom: 30px; display: flex; justify-content: space-between; align-items: center; }
  .verdict-value { font-size: 36px; font-weight: bold; color: ${color}; }
  .scores { display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 15px; margin-bottom: 30px; }
  .score-card { background: #1A3A5C; border-radius: 8px; padding: 15px; text-align: center; }
  .score-num { font-size: 48px; font-weight: bold; color: ${color}; }
  .score-label { font-size: 10px; color: #aaa; text-transform: uppercase; }
  .section { margin-bottom: 30px; }
  .section-title { font-size: 18px; font-weight: bold; margin-bottom: 15px; color: #00B4D8; }
  .item { padding: 8px 0; border-bottom: 1px solid #1A3A5C; font-size: 13px; }
  .item:before { content: "✓ "; color: #28a745; }
  .item.negative:before { content: "⚠ "; color: #ffc107; }
  .item.redflag:before { content: "✗ "; color: #dc3545; }
  .footer { text-align: center; color: #aaa; font-size: 10px; margin-top: 30px; padding-top: 15px; border-top: 1px solid #1A3A5C; }
</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="logo">🚗 EASY<span>CAR</span>CHECK</div>
    <div class="report-num">Rapport #${reportNumber} · JUIN 2026</div>
  </div>
  <div class="title">${analyse.marque?.toUpperCase()}</div>
  <div class="subtitle">${analyse.modele}</div>
  <div class="grid">
    <div class="card"><div class="card-label">ANNÉE</div><div class="card-value">${analyse.annee}</div></div>
    <div class="card"><div class="card-label">KILOMÉTRAGE</div><div class="card-value">${analyse.kilometrage}</div></div>
    <div class="card"><div class="card-label">PRIX DEMANDÉ</div><div class="card-value">${analyse.prix}</div></div>
    <div class="card"><div class="card-label">CARBURANT</div><div class="card-value">${analyse.carburant}</div></div>
    <div class="card"><div class="card-label">BOÎTE</div><div class="card-value">${analyse.boite}</div></div>
    <div class="card"><div class="card-label">PUISSANCE</div><div class="card-value">${analyse.puissance}</div></div>
  </div>
  <div class="verdict-box">
    <div>
      <div style="font-size:10px;color:#aaa;">⭐ VERDICT EASYCARCHECK</div>
      <div class="verdict-value">${analyse.verdict}</div>
      <div style="color:#aaa;font-size:12px;">Analyse spécialisée marché suisse</div>
    </div>
    <div style="text-align:right;">
      <div style="font-size:10px;color:#aaa;">ÉCONOMIE POTENTIELLE</div>
      <div style="font-size:20px;font-weight:bold;color:#00B4D8;">${analyse.economie_potentielle_min?.toLocaleString()} – ${analyse.economie_potentielle_max?.toLocaleString()} CHF</div>
    </div>
  </div>
  <div class="scores">
    <div class="score-card"><div class="score-num">${analyse.score_prix}</div><div>/10</div><div class="score-label">PRIX</div></div>
    <div class="score-card"><div class="score-num">${analyse.score_fiabilite}</div><div>/10</div><div class="score-label">FIABILITÉ</div></div>
    <div class="score-card"><div class="score-num">${analyse.score_entretien}</div><div>/10</div><div class="score-label">ENTRETIEN</div></div>
    <div class="score-card"><div class="score-num">${analyse.score_global}</div><div>/10</div><div class="score-label">GLOBAL</div></div>
  </div>
  <div class="section">
    <div class="section-title">🔧 POINTS CLÉS</div>
    ${(analyse.points_positifs || []).map(p => `<div class="item">${p}</div>`).join('')}
    ${(analyse.points_negatifs || []).map(p => `<div class="item negative">${p}</div>`).join('')}
  </div>
  ${analyse.red_flags?.length > 0 ? `
  <div class="section">
    <div class="section-title">🚨 RED FLAGS</div>
    ${analyse.red_flags.map(r => `<div class="item redflag">${r}</div>`).join('')}
  </div>` : ''}
  ${analyse.problemes_connus_modele?.length > 0 ? `
  <div class="section">
    <div class="section-title">⚠️ PROBLÈMES CONNUS DU MODÈLE</div>
    ${analyse.problemes_connus_modele.map(p => `<div class="item negative">${p}</div>`).join('')}
  </div>` : ''}
  <div class="section">
    <div class="section-title">✅ CHECKLIST VISITE</div>
    ${(analyse.checklist_visite || []).map(c => `<div class="item">${c}</div>`).join('')}
  </div>
  <div class="section">
    <div class="section-title">❓ QUESTIONS À POSER AU VENDEUR</div>
    ${(analyse.questions_vendeur || []).map(q => `<div class="item">${q}</div>`).join('')}
  </div>
  <div class="section">
    <div class="section-title">🗺 TAXE CANTONALE GENÈVE ESTIMÉE</div>
    <div class="card" style="display:inline-block;min-width:200px;">
      <div class="card-label">GENÈVE</div>
      <div class="card-value" style="color:#00B4D8;">${analyse.taxe_cantonale_ge?.toLocaleString()} CHF/an</div>
    </div>
  </div>
  <div class="verdict-box">
    <div>
      <div style="font-size:10px;color:#aaa;">🏆 VERDICT FINAL</div>
      <div class="verdict-value">${analyse.verdict}</div>
      <div style="color:#aaa;font-size:13px;margin-top:10px;max-width:500px;">${analyse.resume_verdict}</div>
    </div>
    <div style="text-align:right;">
      <div style="font-size:10px;color:#aaa;">PRIX SUGGÉRÉ</div>
      <div style="font-size:24px;font-weight:bold;color:#00B4D8;">${analyse.prix_negocie_suggere?.toLocaleString()} CHF</div>
    </div>
  </div>
  <div style="font-size:10px;color:#aaa;word-break:break-all;">Source : ${url}</div>
  <div class="footer">
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
  await resend.emails.send({
    from: 'EasyCarCheck <contact@easycarcheck.ch>',
    to: email,
    subject: `🚗 Votre rapport EasyCarCheck #${reportNumber} — ${analyse.marque} ${analyse.modele}`,
    html: `
      <div style="font-family:Arial;background:#0D1B2A;color:#fff;padding:30px;border-radius:10px;">
        <h1 style="color:#00B4D8;">🚗 EasyCarCheck</h1>
        <p>Votre rapport d'analyse est prêt !</p>
        <h2>${analyse.marque} ${analyse.modele} ${analyse.annee}</h2>
        <p>Verdict : <strong style="color:${analyse.verdict === 'ACHETER' ? '#28a745' : analyse.verdict === 'ÉVITER' ? '#dc3545' : '#ffc107'}">${analyse.verdict}</strong></p>
        <p>Score global : <strong>${analyse.score_global}/10</strong></p>
        <p style="color:#aaa;font-size:12px;">Le rapport PDF complet est en pièce jointe.</p>
        <p style="color:#aaa;font-size:11px;">EasyCarCheck · easycarcheck.ch</p>
      </div>
    `,
    attachments: [{
      filename: `EasyCarCheck_Rapport_${reportNumber}.pdf`,
      content: pdfBuffer.toString('base64')
    }]
  });
}

// ─── ROUTES ──────────────────────────────────────────────

app.get('/', (req, res) => res.json({ status: 'EasyCarCheck Backend OK 🚗' }));

// Analyse gratuite
app.post('/analyse-gratuite', async (req, res) => {
  try {
    const { url, langue = 'fr' } = req.body;
    if (!url) return res.status(400).json({ error: 'URL manquante' });

    const scraped = await scrapeAnnonce(url);
    const analyse = await analyserAvecGPT(scraped, langue, url);

    res.json({
      marque: analyse.marque,
      modele: analyse.modele,
      annee: analyse.annee,
      prix: analyse.prix,
      score_global: analyse.score_global,
      verdict: analyse.verdict,
      teaser: true
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Créer session Stripe
app.post('/create-checkout', async (req, res) => {
  try {
    const { url, email, langue = 'fr', pack = 'single' } = req.body;

    const prices = { single: 1200, pack3: 3000, pack5: 4500 };

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
          unit_amount: prices[pack] || 1200
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

// Webhook Stripe
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
      const analyse = await analyserAvecGPT(scraped, langue);
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
