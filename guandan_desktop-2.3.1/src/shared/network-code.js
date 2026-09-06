(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.GuandanNetwork=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const MODE_PREFIX={lan:'L',public:'P'};
  function normalizeRoomCode(v=''){return String(v).toUpperCase().replace(/[^A-Z0-9]/g,'');}
  function isIPv4(ip){
    const p=String(ip).trim().split('.');
    return p.length===4&&p.every(x=>/^\d{1,3}$/.test(x)&&Number(x)>=0&&Number(x)<=255);
  }
  function ipv4ToInt(ip){
    if(!isIPv4(ip))throw new Error('IPv4 地址无效');
    return ip.split('.').reduce((n,x)=>(n<<8n)|BigInt(Number(x)),0n);
  }
  function intToIPv4(n){
    const a=[];for(let i=3;i>=0;i--)a.push(Number((n>>BigInt(i*8))&255n));return a.join('.');
  }
  function checksum(text){
    let n=17;for(const ch of text)n=(n*33+ch.charCodeAt(0))%1296;
    return n.toString(36).toUpperCase().padStart(2,'0');
  }
  function randomNonce(){return Math.floor(Math.random()*65536);}
  function encodeRoomCode(mode,ip,port,nonce=randomNonce()){
    const prefix=MODE_PREFIX[mode];
    if(!prefix)throw new Error('联机模式无效');
    port=Number(port);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('端口无效');
    nonce=Number(nonce);if(!Number.isInteger(nonce)||nonce<0||nonce>65535)throw new Error('房间随机码无效');
    // 32-bit IPv4 + 16-bit port + 16-bit random nonce，保证同一 IP/端口每次建房的房间码也不同。
    const value=(ipv4ToInt(ip)<<32n)|(BigInt(port)<<16n)|BigInt(nonce);
    const body=value.toString(36).toUpperCase().padStart(13,'0');
    return `${prefix}${body}${checksum(prefix+body)}`;
  }
  function decodeModern(clean){
    const prefix=clean[0],body=clean.slice(1,14),check=clean.slice(14);
    if(checksum(prefix+body)!==check)throw new Error('房间码校验失败，请检查是否输错');
    let value=0n;for(const ch of body){const d=parseInt(ch,36);if(!Number.isFinite(d))throw new Error('房间码无效');value=value*36n+BigInt(d);}
    const nonce=Number(value&65535n);
    const port=Number((value>>16n)&65535n);
    const ip=intToIPv4(value>>32n);
    if(!isIPv4(ip)||!port)throw new Error('房间码无效');
    return {mode:prefix==='L'?'lan':'public',ip,port,nonce,url:`ws://${ip}:${port}`,roomCode:clean};
  }
  function decodeLegacy(clean){
    const prefix=clean[0],body=clean.slice(1,11),check=clean.slice(11);
    if(checksum(prefix+body)!==check)throw new Error('房间码校验失败，请检查是否输错');
    let value=0n;for(const ch of body){const d=parseInt(ch,36);if(!Number.isFinite(d))throw new Error('房间码无效');value=value*36n+BigInt(d);}
    const port=Number(value&65535n),ip=intToIPv4(value>>16n);
    if(!isIPv4(ip)||!port)throw new Error('房间码无效');
    return {mode:prefix==='L'?'lan':'public',ip,port,nonce:null,url:`ws://${ip}:${port}`,roomCode:clean};
  }
  function decodeRoomCode(code){
    const clean=normalizeRoomCode(code);
    if(!['L','P'].includes(clean[0]))throw new Error('房间码格式不正确');
    if(clean.length===16)return decodeModern(clean);
    if(clean.length===13)return decodeLegacy(clean); // 兼容早期 2.3 测试码
    throw new Error('房间码格式不正确');
  }
  function prettyRoomCode(code){
    const clean=normalizeRoomCode(code);
    if(clean.length===16&&['L','P'].includes(clean[0]))return `${clean.slice(0,4)}-${clean.slice(4,8)}-${clean.slice(8,12)}-${clean.slice(12)}`;
    if(clean.length===13&&['L','P'].includes(clean[0]))return `${clean.slice(0,5)}-${clean.slice(5,9)}-${clean.slice(9)}`;
    return clean;
  }
  function encodePublicRoomCode(ip,port){return encodeRoomCode('public',ip,port);}
  function encodeLanRoomCode(ip,port){return encodeRoomCode('lan',ip,port);}
  function decodePublicRoomCode(code){const d=decodeRoomCode(code);if(d.mode!=='public')throw new Error('这不是公网房间码');return d;}
  function decodeLanRoomCode(code){const d=decodeRoomCode(code);if(d.mode!=='lan')throw new Error('这不是局域网房间码');return d;}
  return {normalizeRoomCode,isIPv4,encodeRoomCode,decodeRoomCode,prettyRoomCode,encodePublicRoomCode,encodeLanRoomCode,decodePublicRoomCode,decodeLanRoomCode};
});
