// Serves the production build to the local network over https, with a self-signed certificate,
// for trying WebGPU on a phone: browsers only offer WebGPU to pages loaded securely, and a
// plain http address on the network does not count.
//
//   npx vite build
//   npx vite preview --config vite.lan.config.js --host --port 5185
//
// The phone will warn about the certificate; accept it to carry on.
import basicSsl from '@vitejs/plugin-basic-ssl';

export default {
    plugins: [basicSsl()]
};
