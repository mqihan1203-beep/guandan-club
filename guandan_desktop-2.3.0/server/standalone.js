const { createRoomServer } = require('./room-server');
const port = Number(process.env.PORT || process.argv[2] || 37821);
const roomName = process.env.ROOM_NAME || '公网掼蛋房间';
createRoomServer({ port, roomName, advertise:false }).then(server => {
  const info = server.info();
  console.log(`掼蛋联机服务器已启动: ws://0.0.0.0:${info.port}`);
  console.log(`房间码: ${info.roomCode}`);
  console.log('无需登录。将此端口开放到公网后，客户端可通过 ws://服务器IP:端口 连接。');
}).catch(err => {
  console.error(err);
  process.exit(1);
});
