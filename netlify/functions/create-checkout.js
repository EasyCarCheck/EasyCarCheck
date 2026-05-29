const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const data = JSON.parse(event.body);
  const { email, annonce, vin, marque, modele, annee, km, prix } = data;

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
        annonce: annonce || '',
        vin: vin || '',
        marque: marque || '',
        modele: modele || '',
        annee: annee || '',
        km: km || '',
        prix: prix || '',
        email: email || '',
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
