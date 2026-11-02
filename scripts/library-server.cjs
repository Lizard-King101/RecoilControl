// Local development endpoint. The desktop app starts its own private instance automatically.
const path = require('node:path');
const { FilePackRepository } = require('../build/community/repository');
const { startLibraryService } = require('../build/community/service');
(async()=>{
  const directory=process.env.RECOIL_LIBRARY_DATA || path.resolve('.tmp/community-library');
  const service=await startLibraryService(new FilePackRepository(directory),Number(process.env.RECOIL_LIBRARY_PORT || 5189),process.env.RECOIL_LIBRARY_TOKEN);
  console.log(`Local library: ${service.url}\nStorage: ${directory}`);
  if(!process.env.RECOIL_LIBRARY_TOKEN)console.log(`Development bearer token: ${service.token}`);
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>service.close());
})().catch(error=>{console.error(error.message);process.exitCode=1;});
