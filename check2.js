const h=require('fs').readFileSync('C:\\Users\\lucas\\Desktop\\call\\tmp.html','utf8');
const bodyStart=h.indexOf('<body>');
const scriptMain=h.indexOf('<script>\n(function(){', bodyStart);
const html= h.substring(bodyStart, scriptMain);
const opens=(html.match(/<div[\s>]/g)||[]).length;
const closes=(html.match(/<\/div>/g)||[]).length;
console.log('Open divs:', opens);
console.log('Close divs:', closes);
console.log('Diff:', opens-closes);

const needed=['landing-cta','landing-page','auth-card','login-form','register-form','forgot-form','reset-form'];
const missing=needed.filter(id=>!html.includes('id="'+id+'"'));
console.log('Missing IDs:', missing.length ? missing.join(', ') : 'none');

// Check if auth-screen has hidden class initially
const authScreen=html.match(/id="auth-screen"[^>]*/);
console.log('auth-screen attrs:', authScreen ? authScreen[0] : 'NOT FOUND');
