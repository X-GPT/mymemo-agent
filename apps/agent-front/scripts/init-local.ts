import { CreateBucketCommand } from "@aws-sdk/client-s3";
import { localBucket, localClient, localS3, localTable } from "../src/local";
import { createTable } from "../src/table";

await createTable(localClient, localTable);
console.log(`Created ${localTable}`);
localClient.destroy();

await localS3.send(new CreateBucketCommand({ Bucket: localBucket }));
console.log(`Created ${localBucket}`);
localS3.destroy();
