import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// 데몬이 dist 를 서빙한다. 개발 중에는 vite 가 /api 를 데몬으로 넘긴다
export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, target: "safari16" },
  server: {
    host: "127.0.0.1",
    port: 5174,
    proxy: { "/api": { target: "http://127.0.0.1:47615", ws: true } },
  },
});
