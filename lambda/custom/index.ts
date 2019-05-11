"use strict";

import axios, {AxiosRequestConfig} from "axios";
import * as line from '@line/bot-sdk';
import {DocumentClient} from "aws-sdk/clients/dynamodb";

// ------------------------------------------------------
// 変数・定数定義
// ------------------------------------------------------
const AWS = require("aws-sdk");
const POSTALCODE_TABLE = "ClothCheckPostalCodeForUser";
const USERTEMPERATURE_TABLE = "ClothCheckTempForUser";
const COUNTRYCODE = "JP";
const REGION = "ap-northeast-1";

const enum RESULT {
  HOT = "あつい",
  COLD = "さむい",
  GOOD = "ちょうどいい"
};

const lineSDKConfig = {
  channelAccessToken: process.env.ACCESSTOKEN as string,
  channelSecret: process.env.CHANNEL_SECRET as string,
};

line.middleware(lineSDKConfig);
const lineClient = new line.Client(lineSDKConfig);

AWS.config.update({
  region: REGION,
});

const documentClient = new AWS.DynamoDB.DocumentClient({apiVersion: '2012-08-10'});


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

const lineAPIImageConfig: AxiosRequestConfig = {
  method: "get",
  baseURL: 'https://api.line.me',
  timeout: 10000,
  responseType: 'json',
  headers: {
    "Authorization": "Bearer " + process.env.ACCESSTOKEN // LINE Developersの「Channel Access Token」を使用
  },
  validateStatus: (status: number) => status >= 200 && status < 300,
};

/**
 * エンティティ解決時の成功コード
 * @type {string}
 */
const ER_SUCCESS_MATCH = "ER_SUCCESS_MATCH";

// ------------------------------------------------------

/* LAMBDA SETUP */
exports.handler = async (event: any, context: any, callback: any) => {
  console.log(JSON.stringify(event, null, 2));

  const events = event.events;
  for (let i = 0; i < events.length; i++) {
    let data = events[i];
    const replyToken = data.replyToken;

    if (data['type'] == 'message') {
      // 郵便番号の応答かどうかをチェック
      let text = data.message.text as string;
      const userId = data.source.userId;
      if (text.length <= 8 && text.match(/[0-9]{3}-[0-9]{4}|[0-9]{7}/)) {
        if (!text.match(/-/)) {
          text = `${text.substr(0, 3)}-${text.substr(3, 4)}`;
        }

        const params = {
          TableName: POSTALCODE_TABLE,
          Item: {
            'id': userId,
            'postalCode': text
          },
        };

        // 郵便番号を登録
        try {
          await insertRecord(params);
        } catch (err) {
          callback(err);
        }

        try {
          await lineClient.replyMessage(replyToken, {type: "text", text: `${text}で郵便番号情報を登録しました。`});
        } catch (err) {
          callback(err);
        }

        return {
          statusCode: 200,
          body: JSON.stringify("postal code register"),
        };
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
        callback(err);
      }

      if (!postalCode) {
        await lineClient.replyMessage(replyToken, {
          type: "text",
          text: '郵便番号を教えてください（例：100-0004）',
        });
      } else {
        // 登録位置情報から天気情報を取得
        const addressInfo = `${postalCode},${COUNTRYCODE}`;
        const url = `/data/2.5/weather?units=metric&zip=${addressInfo}&APPID=${process.env.WEATHER_APIKEY}`;
        let weather, temperature;
        try {
          weather = await axios.get(url, config);
          temperature = Math.floor(weather.data.main.temp);
          // await lineClient.replyMessage(replyToken, {
          //   type: "text",
          //   text: `${temperature}度の感想は${text}で記録したよ。`,
          // });

          // 登録済みでない気温の場合、登録してもらうように促す
          const isSet = await isSetTemperature({
            TableName: USERTEMPERATURE_TABLE,
            KeyConditionExpression: 'id = :hkey and temperature > :rkey',
            ExpressionAttributeValues: {
              ':hkey': userId,
              ':rkey': temperature
            },
          });

          console.log(isSet);
          if (!isSet) {
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
            })

            return {
              statusCode: 200,
              body: JSON.stringify("postal code register"),
            };
          }
        } catch (e) {
          callback(e);
        }

        const message = data.message;
        const text = message.text;

        data = JSON.stringify({
          replyToken: replyToken,
          messages: [{type: "text", text: 'ん？なんだって？'}]
        });

        // 画像取得
        if (message.type === "image") {
          const url = `/v2/bot/message/${message.id}/content`;
          const resp = await axios.get(url, lineAPIImageConfig);
        }

        await lineClient.replyMessage(replyToken, {
          type: "text",
          text: 'ほげほげ',
        });
      }

      callback(null, "OK, Lambda");

      return {
        statusCode: 200,
        body: JSON.stringify("OK"),
      };
    } else if (data['type'] == 'postback') {
      // DynamoDBにデータを送信
      const userId = data.source.userId;
      const temperature = data.postback.data.split("&")[0];
      const result = data.postback.data.split("&")[1];

      const params = {
        TableName: USERTEMPERATURE_TABLE,
        Item: {
          'id': userId,
          "temperature": parseInt(temperature),
          result,
        },
      };

      try {
        await insertRecord(params);
      } catch (err) {
        callback(err);
      }

      try {
        await lineClient.replyMessage(replyToken, {
          type: "text",
          text: `${temperature}度の感想は${result}で記録したよ。`,
        });
      } catch (err) {
        callback(err);
      }

      return {
        statusCode: 200,
        body: JSON.stringify("postal code register"),
      };
    }
  }

  const response = {
    statusCode: 200,
    body: JSON.stringify('OK'),
  };
  return response;
}

/**
 *
 * @param params
 */
const getPostalCode = async (params: DocumentClient.GetItemInput): Promise<string | null> => {
  try {
    const data = await documentClient.get(params).promise();
    console.log("Success get postalcode", data.Item);
    return data.Item.postalCode;
  } catch (err) {
    console.log("Error", err);
    return null;
  }
}

/**
 *
 * @param params
 */
const insertRecord = async (params: DocumentClient.PutItemInput): Promise<boolean> => {
  try {
    await documentClient.put(params).promise();
    console.log("Success put postalcode");
    return true;
  } catch (err) {
    console.log("Error", err);
    return false;
  }
}

/**
 *
 * @param params
 */
const isSetTemperature = async (params: DocumentClient.QueryInput): Promise<boolean> => {
  try {
    const data = await documentClient.query(params).promise();
    return data.Count > 0;
  } catch (err) {
    console.log("Error", err);
  }
  return false;
}
