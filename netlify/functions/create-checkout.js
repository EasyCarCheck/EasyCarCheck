const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const data = JSON.parse(event.body);
  const {
    email, annonce, vin,
    marque, modele, annee, km, prix,
    carrosserie, puissance, couleur, proprio,
    canton, carburant, boite, co2, poids,
    provenance, mfk, options
  } = data;

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'twint'],
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'chf',
          product_data: {
            name: 'Rapport EasyCarCheck',
            description: 'Analyse IA véhicule d\'occasion — marché suisse',
          },
          unit_amount: 900,
        },
        quantity: 1,
      }],
      mode: 'payment',
      metadata: {
        // Identification
        email:        (email       || '').substring(0, 500),
        annonce:      (annonce     || '').substring(0, 500),
        vin:          (vin         || '').substring(0, 500),
        // Infos de base
        marque:       (marque      || '').substring(0, 500),
        modele:       (modele      || '').substring(0, 500),
        annee:        (annee       || '').substring(0, 500),
        km:           (km          || '').substring(0, 500),
        prix:         (prix        || '').substring(0, 500),
        carrosserie:  (carrosserie || '').substring(0, 500),
        puissance:    (puissance   || '').substring(0, 500),
        couleur:      (couleur     || '').substring(0, 500),
        proprio:      (proprio     || '').substring(0, 500),
        // Technique
        carburant:    (carburant   || '').substring(0, 500),
        boite:        (boite       || '').substring(0, 500),
        co2:          (co2         || '').substring(0, 500),
        poids:        (poids       || '').substring(0, 500),
        // Provenance & MFK
        provenance:   (provenance  || '').substring(0, 500),
        mfk:          (mfk         || '').substring(0, 500),
        canton:       (canton      || '').substring(0, 500),
        // Options
        options:      (options     || '').substring(0, 500),
      },
      success_url: 'https://easycarcheck.ch/merci.html',
      cancel_url: 'https://easycarcheck.ch/#analyser',
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ url: session.url }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
