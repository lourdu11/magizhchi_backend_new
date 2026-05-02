require('dotenv').config();

// Check account status and try to send directly
const run = async () => {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.error('BREVO_API_KEY not set in .env');
    return;
  }

  // 1. Check account
  const accountRes = await fetch('https://api.brevo.com/v3/account', {
    headers: { 'api-key': apiKey }
  });
  const account = await accountRes.json();
  console.log('\n=== BREVO ACCOUNT ===');
  console.log('Email:', account.email);
  console.log('Company:', account.companyName);
  console.log('Plan Type:', account.plan?.[0]?.type);
  console.log('Plan Credits:', account.plan?.[0]?.credits);
  console.log('Plan Feature-Type:', account.plan?.[0]?.featureType);

  // 2. Check senders
  const sendersRes = await fetch('https://api.brevo.com/v3/senders', {
    headers: { 'api-key': apiKey }
  });
  const senders = await sendersRes.json();
  console.log('\n=== VERIFIED SENDERS ===');
  (senders.senders || []).forEach(s => {
    console.log(`  ${s.email} - active: ${s.active}`);
  });

  // 3. Send direct test to lourdufreefire@gmail.com
  console.log('\n=== SENDING TEST EMAIL ===');
  const sendRes = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
    body: JSON.stringify({
      sender: { name: 'Magizhchi Garments', email: account.email },
      to: [{ email: 'lourdufreefire@gmail.com' }],
      subject: 'LIVE TEST ' + new Date().toISOString(),
      htmlContent: '<h1>Live Test</h1><p>If you see this, email is working!</p>'
    })
  });
  const sendData = await sendRes.json();
  console.log('Send Status:', sendRes.status);
  console.log('Send Result:', JSON.stringify(sendData));
};

run().catch(e => console.error('Fatal:', e.message));
