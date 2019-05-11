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
const COUNTRY = "JP";
const REGION = "ap-northeast-1";

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
      const text = data.message.text as string;
      if (text.match(/[0-9]{3}-[0-9]{4}|[0-9]{7}/)) {
        const params = {
          TableName: POSTALCODE_TABLE,
          Item: {
            'id': data.source.userId,
            'postalCode': text
          },
        };

        try {
          await insertPostalCode(params);
        } catch (e) {
          console.log("Dynamo Error ", e);
          return {
            statusCode: 500,
            body: JSON.stringify("postal code dynamodb put error"),
          };
        }

        try {
          await lineClient.replyMessage(replyToken, {type: "text", text: `${text}で郵便番号情報を登録しました。`});
        } catch (e) {
          console.log("line Error ", e);
          return {
            statusCode: 500,
            body: JSON.stringify("line replay error"),
          };
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
          "id": {
            "S": data.source.userId,
          }
        }
      };
      let postal;
      try {
        postal = await getPostalCode(params);
      } catch (e) {
        return {
          statusCode: 400,
          body: JSON.stringify("postal code dynamodb get error"),
        };
      }

      if (!postal) {
        await lineClient.replyMessage(replyToken, {
          type: "text",
          text: '郵便番号を教えてください（例：100-0004）',
        });
      } else {
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
    }
  }

  const response = {
    statusCode: 200,
    body: JSON.stringify('OK'),
  };
  return response;
};

/**
 *
 * @param params
 */
const getPostalCode = async (params: DocumentClient.GetItemInput) => {
  // @ts-ignore
  documentClient.get(params, function (err, data) {
    if (err) {
      console.log("Error", err);
    } else {
      console.log("Success", data.Item);
      return data.Item;
    }
  });
}

/**
 *
 * @param params
 */
const insertPostalCode = async (params: DocumentClient.PutItemInput) => {
  console.log(params);
  // @ts-ignore
  documentClient.put(params, function (err, data) {
    if (err) {
      console.log("Error", err);
    } else {
      console.log("Success ", data);
      return "Success";
    }
  });
}

