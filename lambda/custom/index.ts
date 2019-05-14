"use strict";

import axios, {AxiosRequestConfig} from "axios";
import * as line from '@line/bot-sdk';
import {DocumentClient} from "aws-sdk/clients/dynamodb";
import {message} from "aws-sdk/clients/sns";
import {quickReply} from "./response";
import S3 = require("aws-sdk/clients/s3");

// ------------------------------------------------------
// 変数・定数定義
// ------------------------------------------------------
const AWS = require("aws-sdk");
const POSTALCODE_TABLE = "ClothCheckPostalCodeForUser";
const USERTEMPERATURE_TABLE = "ClothCheckTempForUser";
const COUNTRYCODE = "JP";
const REGION = "ap-northeast-1";
const BUCKET_NAME = "cloth-check-bucket";

const enum RESULT {
  HOT = "あつい",
  COLD = "さむい",
  GOOD = "ちょうどいい"
}

const lineSDKConfig = {
  channelAccessToken: process.env.ACCESSTOKEN as string,
  channelSecret: process.env.CHANNEL_SECRET as string,
};

line.middleware(lineSDKConfig);
const lineClient = new line.Client(lineSDKConfig);

AWS.config.update({
  region: REGION,
});

const documentClient = new AWS.DynamoDB.DocumentClient({apiVersion: 'latest'});
const s3Client = new AWS.S3({apiVersion: 'latest'});

// ------------------------------------------------------
// API定義
// ------------------------------------------------------
const config: AxiosRequestConfig = {
  method: 'get',
  baseURL: 'http://api.openweathermap.org/',
  timeout: 10000,
  responseType: 'json',
  validateStatus: (status: number) => status >= 200 && status < 300,
};

// ------------------------------------------------------
/* LAMBDA SETUP */
exports.handler = async (event: any, context: any, callback: any) => {
  console.log(JSON.stringify(event, null, 2));

  const events = event.events;

  for (let i = 0; i < events.length; i++) {
    let data = events[i];
    const replyToken = data.replyToken;

    if (data['type'] == 'message') {
      if (data.message.type === "image") {
        await imageMessageResponse(data, replyToken);
      } else {
        await testMessageResponse(data, replyToken);
      }
    } else if (data['type'] == 'postback') {
      await postbackResponse(data, replyToken);
    }
  }

  const response = {
    statusCode: 200,
    body: JSON.stringify('OK'),
  };

  return response;

  /**
   *
   * @param data
   * @param replyToken
   */
  async function imageMessageResponse(data: any, replyToken: string) {
    const userId = data.source.userId;
    const timestamp = new Date();

    // ユーザの郵便番号を取得
    // 見つからない場合は郵便番号を入力してもらうようにメッセージを返す
    let postalCode, temperature = 0;
    try {
      postalCode = await getPostalCode({
        TableName: POSTALCODE_TABLE,
        Key: {
          "id": userId,
        }
      });
      const addressInfo = `${postalCode},${COUNTRYCODE}`;
      const url = `/data/2.5/weather?units=metric&zip=${addressInfo}&APPID=${process.env.WEATHER_APIKEY}`;

      // 登録位置情報から天気情報を取得
      const weather = await axios.get(url, config);
      temperature = Math.floor(weather.data.main.temp);
    } catch (err) {
      throw err;
    }

    // 画像取得
    const stream = await lineClient.getMessageContent(data.message.id);
    const filename = `${temperature}${userId}.jpg`;
    const image: any[] = [];

    stream.on('data', (chunk) => {
      image.push(new Buffer(chunk));
    }).on('error', (err) => {
      console.error("[Error] image stream", err);
      throw err;
    }).on('end', async () => {
      const s3Params = {
        Body: Buffer.concat(image),
        Bucket: BUCKET_NAME,
        Key: filename
      };
      putS3Object(s3Params);
      // ここでconsole.log書いても何も出力されない！！！

      // ここでdynamo updateの処理を書いても実行されないように見える！！
      // CAUTION!!!
      //       const dynamoUpdateResponse = await updateRecord(updateParams);
      //       console.log("dynamo update w/ image", dynamoUpdateResponse);
      // 上記だとUpdateは実行はされるが
      // ログ出力はされなかった

      // 画像更新
      const updateParams = {
        TableName: USERTEMPERATURE_TABLE,
        Key: {
          id: userId,
          temperature: temperature,
        },
        UpdateExpression: "set #image = :image, #timestamp = :timestamp",
        ExpressionAttributeNames: {
          "#timestamp": "timestamp",
          "#image": "image",
        },
        ExpressionAttributeValues: {
          ":image": filename,
          ":timestamp": `${timestamp.toLocaleDateString("ja")} ${timestamp.toLocaleTimeString("ja")}`
        }
      };
      const dynamoUpdateResponse = await updateRecord(updateParams);
      console.log("dynamo update w/ image", dynamoUpdateResponse);

    });

    await lineClient.replyMessage(replyToken, {
      type: "text",
      text: '画像の登録が完了しました。',
    });
  }

  /**
   *
   * @param data
   * @param replyToken
   */
  async function testMessageResponse(data: any, replyToken: string) {
    // 郵便番号の応答かどうかをチェック
    let text = data.message.text as string;
    const userId = data.source.userId;
    if (text.length <= 8 && text.match(/[0-9]{3}-[0-9]{4}|[0-9]{7}/)) {
      if (!text.match(/-/)) {
        text = `${text.substr(0, 3)}-${text.substr(3, 4)}`;
      }

      const timestamp = new Date();
      const params = {
        TableName: POSTALCODE_TABLE,
        Item: {
          'id': userId,
          'postalCode': text,
          'timestamp': `${timestamp.toLocaleDateString("ja")} ${timestamp.toLocaleTimeString("ja")}`,
        },
      };

      // 郵便番号を登録
      try {
        await insertRecord(params);
      } catch (err) {
        throw err;
      }

      try {
        await lineClient.replyMessage(replyToken, {type: "text", text: `${text}で郵便番号情報を登録しました。`});
      } catch (err) {
        throw err;
      }
    }

    // ユーザの郵便番号を取得
    // 見つからない場合は郵便番号を入力してもらうようにメッセージを返す
    const params = {
      TableName: POSTALCODE_TABLE,
      Key: {
        "id": userId,
      }
    };
    let postalCode;
    try {
      postalCode = await getPostalCode(params);
    } catch (err) {
      throw err;
    }

    if (!postalCode) {
      // 郵便番号を入力するように要求
      await lineClient.replyMessage(replyToken, {
        type: "text",
        text: '郵便番号を教えてください（例：100-0004）',
      });
    } else {
      // 郵便番号登録済みの処理
      //  気温が登録済みなら何も登録はせず更新したい場合の手順だけ応答
      //  気温未登録の場合は気温と感想、写真を登録してもらうように誘導する

      const addressInfo = `${postalCode},${COUNTRYCODE}`;
      const url = `/data/2.5/weather?units=metric&zip=${addressInfo}&APPID=${process.env.WEATHER_APIKEY}`;
      let weather, temperature;
      try {
        // 登録位置情報から天気情報を取得
        weather = await axios.get(url, config);
        temperature = Math.floor(weather.data.main.temp);
        const temperatureSearchResp = await isSetTemperature({
          TableName: USERTEMPERATURE_TABLE,
          KeyConditionExpression: 'id = :hkey and temperature = :rkey',
          ExpressionAttributeValues: {
            ':hkey': userId,
            ':rkey': temperature
          },
        });

        // 未登録の気温の場合、登録してもらうように促す
        // @ts-ignore
        if (temperatureSearchResp.Count === 0 || (!temperatureSearchResp.Items[0].timestamp)) {
          await lineClient.replyMessage(replyToken, {
            type: "template",
            altText: `今日は${temperature}でしたが気温はどうでしたか？`,
            template: {
              type: "buttons",
              text: `今日は${temperature}でしたが気温はどうでしたか？`,
              actions: [
                {
                  "type": "postback",
                  "label": RESULT.HOT,
                  "data": `${temperature}&${RESULT.HOT}`,
                },
                {
                  "type": "postback",
                  "label": RESULT.COLD,
                  "data": `${temperature}&${RESULT.COLD}`,
                },
                {
                  "type": "postback",
                  "label": RESULT.GOOD,
                  "data": `${temperature}&${RESULT.GOOD}`,
                }
              ]
            }
          });

          return;

        } else {
          //
          const item = temperatureSearchResp.Items![0];

          if (!item.image) {
            await lineClient.replyMessage(replyToken, {
              type: "text",
              text: 'この気温の時の感想は登録済みです。より良い記録のために服装をアップロードしてください。',
              quickReply,
            });

            return;
          }

          await lineClient.replyMessage(replyToken, [{
            type: "text",
            text: `${temperature}度の時の感想は${item.result}です。更新したい場合、感想と新しい画像をアップロードしてください。`,
          }, {
            type: "image",
            // originalContentUrl: `${process.env.S3_PATH}/${item.image}`,
            // previewImageUrl: "https://example.com/preview.jpg",
            originalContentUrl: `${process.env.S3_PATH}/sample.jpg`,
            previewImageUrl: `${process.env.S3_PATH}/sample-preview.jpg`,

          },
            {
              type: "template",
              altText: `感想を更新したい場合は下記から選択してください。`,
              template: {
                type: "buttons",
                text: `感想を更新したい場合は下記から選択してください。`,
                actions: [
                  {
                    "type": "postback",
                    "label": RESULT.HOT,
                    "data": `${temperature}&${RESULT.HOT}`,
                  },
                  {
                    "type": "postback",
                    "label": RESULT.COLD,
                    "data": `${temperature}&${RESULT.COLD}`,
                  },
                  {
                    "type": "postback",
                    "label": RESULT.GOOD,
                    "data": `${temperature}&${RESULT.GOOD}`,
                  }
                ]
              }
            }]);
        }
      } catch (e) {
        throw e;
      }
    }
  }

  /**
   *
   * @param data
   * @param replyToken
   */
  async function postbackResponse(data: any, replyToken: string) {
    // DynamoDBにデータを送信
    const userId = data.source.userId;
    const temperature = data.postback.data.split("&")[0];
    const result = data.postback.data.split("&")[1];

    const timestamp = new Date();

    // 画像更新
    const updateParams = {
      TableName: USERTEMPERATURE_TABLE,
      Key: {
        'id': userId,
        "temperature": parseInt(temperature),
      },
      AttributeUpdates: {
        result: {
          Action: "PUT",
          Value: result,
        },
        timestamp: {
          Action: "PUT",
          Value: `${timestamp.toLocaleDateString("ja")} ${timestamp.toLocaleTimeString("ja")}`,
        }
      },
    };

    try {
      // 気温の感想情報を登録
      await updateRecord(updateParams);
    } catch (err) {
      throw err;
    }

    try {
      await lineClient.replyMessage(replyToken, [
        {
          type: "text",
          text: `${temperature}度の感想は${result}で記録したよ。あわせて今日の服装をアップロードしてね。`,
          quickReply
        }
      ]);
    } catch (err) {
      throw err;
    }
  }
};


/**
 *
 * @param params
 */
const getPostalCode = async (params: DocumentClient.GetItemInput): Promise<string | null> => {
  try {
    const data = await documentClient.get(params).promise();
    return data.Item.postalCode;
  } catch (err) {
    console.log("Error", err);
    throw err;
  }
};

/**
 *
 * @param params
 */
const insertRecord = async (params: DocumentClient.PutItemInput): Promise<boolean> => {
  try {
    await documentClient.put(params).promise();
    return true;
  } catch (err) {
    console.log("Error", err);
    throw err;
  }
};

/**
 *
 * @param params
 */
const updateRecord = async (params: DocumentClient.UpdateItemInput): Promise<DocumentClient.UpdateItemOutput> => {
  try {
    return await documentClient.update(params).promise();
  } catch (err) {
    console.log("Error", err);
    throw err;
  }
};


/**
 *
 * @param params
 */
const isSetTemperature = async (params: DocumentClient.QueryInput): Promise<DocumentClient.QueryOutput> => {
  try {
    const data = await documentClient.query(params).promise();
    console.log(data);
    return data;
  } catch (err) {
    console.log("Error", err);
    throw err;
  }
};

/**
 *
 * @param params
 */
const putS3Object = async (params: any): Promise<S3.Types.PutObjectOutput> => {
  try {
    return await s3Client.putObject(params).promise();
  } catch (err) {
    console.log("Error", err);
    throw err;
  }
};
