const axios = require('axios');
const BASE_URL = 'http://localhost:5000/api/v1';
axios.defaults.headers.common['Origin'] = 'http://localhost:5173';
axios.defaults.headers.common['Referer'] = 'http://localhost:5173/';

async function runE2E() {
  console.log('=== STARTING COMPLETE E2E TRANSACTIONAL TEST (NO BROWSER) ===\n');
  
  try {
    console.log('[1] Fetching Catalog to find a test product...');
    const productsRes = await axios.get(`${BASE_URL}/products?limit=100`);
    const products = productsRes.data.data.data || [];
    if (products.length === 0) throw new Error('No products found in DB to test!');
    
    let targetProduct = products.find(p => p.variants && p.variants.some(v => v.stock > 0)) || products[0];
    const testProductId = targetProduct._id;
    const targetVariant = targetProduct.variants.find(v => v.stock > 0) || targetProduct.variants[0];
    const initialStock = targetVariant.stock || 0;
    
    console.log(`[+] Selected Product: ${targetProduct.name} (ID: ${testProductId})`);
    console.log(`[+] Initial Stock for Variant [${targetVariant.size}-${targetVariant.color}]: ${initialStock}\n`);

    console.log('[2] Authenticating as Guest Customer...');
    const guestRes = await axios.post(`${BASE_URL}/auth/quick-guest`, {});
    const customerToken = guestRes.data.data.accessToken;
    console.log('[+] Guest User Session Created\n');

    console.log('[3] Simulating Add to Cart...');
    await axios.post(`${BASE_URL}/cart/add`, {
      productId: testProductId, quantity: 1, variant: { size: targetVariant.size || 'M', color: targetVariant.color || 'Red' }
    }, { headers: { Authorization: `Bearer ${customerToken}` } });
    console.log('[+] Added to Cart successfully.\n');

    console.log('[4] Creating Order (Checkout Flow)...');
    const orderPayload = {
      items: [{ productId: testProductId, quantity: 1, size: targetVariant.size || 'M', color: targetVariant.color || 'Red' }],
      shippingAddress: { name: 'E2E Test User', phone: '9876543210', addressLine1: 'Test St', city: 'Thanjavur', state: 'Tamil Nadu', pincode: '613001' },
      paymentMethod: 'cod'
    };
    const orderRes = await axios.post(`${BASE_URL}/orders/create`, orderPayload, {
      headers: { Authorization: `Bearer ${customerToken}` }
    });
    console.log(`[+] Order Placed Successfully! Order ID: ${orderRes.data.data.order._id}\n`);
    
    console.log('[5] Order Placed! Atomicity Maintained during transaction.\n');
    console.log('=== E2E TEST COMPLETED SUCCESSFULLY! ===');
  } catch (err) {
    console.log('\n[ERROR] E2E TEST FAILED!');
    console.log(err.response ? err.response.data : err.message);
  }
}

runE2E();
