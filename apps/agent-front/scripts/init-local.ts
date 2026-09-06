import { localClient, localTable } from "../src/local";
import { createTable } from "../src/table";

await createTable(localClient, localTable);
console.log(`Created ${localTable}`);
localClient.destroy();
