require('dotenv').config();

// This script adds lourdufreefire@gmail.com as a Brevo contact
// so it can receive emails even when the account is in restricted mode

const addBrevoContact = async () => {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) { console.error('BREVO_API_KEY not set'); return; }

  const emailToAdd = 'lourdufreefire@gmail.com';

  const response = await fetch('https://api.brevo.com/v3/contacts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey
    },
    body: JSON.stringify({
      email: emailToAdd,
      attributes: { FIRSTNAME: 'Admin', LASTNAME: 'Magizhchi' },
      listIds: [],
      updateEnabled: true
    })
  });

  const data = await response.json();
  console.log('Add contact response:', response.status, JSON.stringify(data));

  // Also check account status
  const accountRes = await fetch('https://api.brevo.com/v3/account', {
    headers: { 'api-key': apiKey }
  });
  const accountData = await accountRes.json();
  console.log('Account email:', accountData.email);
  console.log('Account plan:', accountData.plan?.[0]?.type);
  console.log('Account features:', JSON.stringify(accountData.plan));
};

addBrevoContact().catch(console.error);
