import {
	CreateTableCommand,
	type DynamoDBClient,
} from "@aws-sdk/client-dynamodb";

export async function createTable(client: DynamoDBClient, table: string) {
	await client.send(
		new CreateTableCommand({
			TableName: table,
			BillingMode: "PAY_PER_REQUEST",
			DeletionProtectionEnabled: true,
			KeySchema: [
				{ AttributeName: "PK", KeyType: "HASH" },
				{ AttributeName: "SK", KeyType: "RANGE" },
			],
			AttributeDefinitions: [
				"PK",
				"SK",
				"GSI1PK",
				"GSI1SK",
				"GSI2PK",
				"GSI2SK",
			].map((AttributeName) => ({ AttributeName, AttributeType: "S" })),
			GlobalSecondaryIndexes: [
				{
					IndexName: "GSI1",
					KeySchema: [
						{ AttributeName: "GSI1PK", KeyType: "HASH" },
						{ AttributeName: "GSI1SK", KeyType: "RANGE" },
					],
					Projection: { ProjectionType: "ALL" },
				},
				{
					IndexName: "GSI2",
					KeySchema: [
						{ AttributeName: "GSI2PK", KeyType: "HASH" },
						{ AttributeName: "GSI2SK", KeyType: "RANGE" },
					],
					Projection: { ProjectionType: "KEYS_ONLY" },
				},
			],
		}),
	);
	// DynamoDB Local has no PITR API; Terraform enables PITR in AWS.
}
