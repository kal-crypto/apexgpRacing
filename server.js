// Root entry point so Render works whether its "Root Directory" is the repo
// root (this shim) or the /server folder (server/server.js directly).
require('./server/server.js');
