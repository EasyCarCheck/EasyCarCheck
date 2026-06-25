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
        antibot: 'true',
        response_type: 'markdown'
      },
      timeout: 60000
    });

    let html = response.data;
    if (typeof html !== 'string') html = JSON.stringify(html);
    html = html.replace(/\s+/g, ' ').trim();

    console.log('ZENROWS OK:', html.substring(0, 500));
    return { html: html.substring(0, 8000), url: url };
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
- Description du vendeur
- Options listées

ÉTAPE 2 - Analyse approfondie :
- Compare le prix avec le marché suisse actuel
- Identifie TOUS les problèmes connus de ce modèle
- Pour Mercedes A35 AMG : problème culasse moteur M260 récurrent, remplacement 5000-8000 CHF hors garantie, boîte DCT fragile
- Détecte les red flags dans la description vendeur
- Si "Zylinderkopf" mentionné → red flag majeur culasse remplacée

ÉTAPE 3 - Génère le rapport en ${langues[langue] || 'français'}.

RÈGLES ABSOLUES :
1. Réponds UNIQUEMENT avec du JSON valide sans apostrophes dans les chaînes
2. Le champ verdict = UNIQUEMENT ACHETER, NÉGOCIER ou ÉVITER
3. prix_negocie_suggere doit être un nombre réaliste jamais 0
4. Utilise uniquement des guillemets doubles dans le JSON
5. Pas de virgule après le dernier élément d'un tableau ou objet

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
        try {
          return JSON.parse(match[0]);
        } catch(e3) {
          throw new Error('JSON invalide');
        }
      }
      throw new Error('JSON invalide');
    }
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
  const result = await resend.emails.send({
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
  console.log('RESEND RESULT:', JSON.stringify(result));
}

// ─── ROUTES ──────────────────────────────────────────────

app.get('/', (req, res) => res.json({ status: 'EasyCarCheck Backend OK 🚗' }));

// Route test rapport sans paiement
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
