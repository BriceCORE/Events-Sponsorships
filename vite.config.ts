import {defineConfig} from "vite";
import react from "@vitejs/plugin-react";
import {fileURLToPath, URL} from "node:url";
export default defineConfig({base:"./",plugins:[react()],resolve:{alias:{"@":fileURLToPath(new URL(".",import.meta.url))}},server:{host:"127.0.0.1",port:5174,strictPort:true,proxy:{'/api':'http://localhost:5173'},watch:{usePolling:true}},build:{outDir:"dist"}});
