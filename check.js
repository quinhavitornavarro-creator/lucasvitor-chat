const fs=require('fs');
const html=fs.readFileSync('temp_live.html','utf8');
const m=html.match(/<script>([\s\S]*?)<\/script>/);
if(!m) { console.log('No script found'); process.exit(1); }
const js=m[1];
const lines=js.split('\n');
// Look for bare $(...) without ?. that could crash
for(let i=0;i<lines.length;i++){
  const line=lines[i];
  // Find $('something').something (no ?. before the dot)
  if(line.includes("$('") && line.includes(").") && !line.includes(")?.") && !line.includes("?.(")){
    console.log((i+1)+': '+line.trim().substring(0,150));
  }
}
