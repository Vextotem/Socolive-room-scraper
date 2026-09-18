FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8000
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
