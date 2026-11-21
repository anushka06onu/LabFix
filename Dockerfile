FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node package.json server.mjs store.mjs matching.mjs ./
COPY --chown=node:node public ./public
RUN mkdir /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=8080 LABFIX_DB=/data/labfix.sqlite
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server.mjs"]
