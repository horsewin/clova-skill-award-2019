"use strict";

import axios, {AxiosRequestConfig} from "axios";
import {DynamoDB} from "aws-sdk";
import AWS = require("aws-sdk");

// ------------------------------------------------------
// 変数・定数定義
// ------------------------------------------------------
const util = require("util");
const MESSAGE = require("./message");
const POSTALCODE_TABLE = "ClothCheckPostalCodeForUser";
const USERTEMPERATURE_TABLE = "DayTempForUser";
const COUNTRY = "JP";
const REGION = "ap-northeast1";

AWS.config.update({
  region: REGION,
});

const dynamodb = new AWS.DynamoDB({apiVersion: "2012-08-10"});

const enum STATE {
  INPUT = "input",
}

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

const lineAPIConfig: AxiosRequestConfig = {
  method: "post",
  baseURL: 'https://api.line.me',
  timeout: 10000,
  responseType: 'json',
  headers: {
    "Content-type": "application/json; charset=UTF-8",
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
        const params: DynamoDB.Types.PutItemInput = {
          TableName: POSTALCODE_TABLE,
          Item: {
            'id' : {S: data.source.userId},
            'postalcode' : {S: text}
          },
        };

        try {
          await insertPostalCode(params);
          data = JSON.stringify({
            replyToken: replyToken,
            messages: [{type: "text", text: `${text}で郵便番号情報を登録しました。`}],
          });
          const url = `/v2/bot/message/reply`;
          await axios.post(url, data, lineAPIConfig);
        } catch (e) {
          console.log(e);
          callback(e);
        }

        callback("郵便番号登録完了");
      }

      // ユーザの郵便番号を取得
      // 見つからない場合は郵便番号を入力してもらうようにメッセージを返す
      const params: DynamoDB.Types.GetItemInput = {
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
        console.log(e);
      }

      if (!postal) {
        data = JSON.stringify({
          replyToken: replyToken,
          messages: [{type: "text", text: '郵便番号を教えてください（例：100-0004）'}],
        });
        const url = `/v2/bot/message/reply`;
        const resp = await axios.post(url, data, lineAPIConfig);
        console.log(resp);
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

        const url = `/v2/bot/message/reply`;
        const resp = await axios.post(url, data, lineAPIConfig);
        console.log(resp);
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
const getPostalCode = async (params: DynamoDB.Types.GetItemInput) => {
  dynamodb.getItem(params, function (err, data) {
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
const insertPostalCode = async (params: DynamoDB.Types.PutItemInput) => {
  dynamodb.putItem(params, function (err, data) {
    if (err) {
      console.log("Error", err);
    } else {
      console.log("Success");
    }
  });
}


// /* INTENT HANDLERS */
// const LaunchRequestHandler = {
//   canHandle(handlerInput: Alexa.HandlerInput) {
//     const request = handlerInput.requestEnvelope.request;
//     return handlerInput.requestEnvelope.request.type === `LaunchRequest`;
//   },
//   async handle(handlerInput: Alexa.HandlerInput) {
//     let speak = null;
//     let reprompt = null;
//     const {requestEnvelope, serviceClientFactory, responseBuilder} = handlerInput;
//     let attributes = await handlerInput.attributesManager.getPersistentAttributes()
//     const consentToken = handlerInput.requestEnvelope.context.System.user.permissions &&
//       handlerInput.requestEnvelope.context.System.user.permissions.consentToken;
//
//     if (!consentToken) {
//       return responseBuilder
//         .speak(MESSAGE.permission.speak)
//         .withAskForPermissionsConsentCard(PERMISSIONS)
//         .getResponse();
//     }
//
//     let greeding = "";
//     const date = new Date();
//
//     // デバイス位置情報の取得
//     let addressInfo = "";
//     try {
//       const {deviceId} = requestEnvelope.context.System.device;
//       const deviceAddressServiceClient = serviceClientFactory.getDeviceAddressServiceClient();
//       const address = await deviceAddressServiceClient.getCountryAndPostalCode(deviceId);
//       if (address.countryCode === null && address.postalCode === null) {
//         return responseBuilder.speak(MESSAGE.error.noaddress).getResponse();
//       } else {
//         addressInfo = `${address.postalCode},${address.countryCode}`;
//       }
//     } catch (error) {
//       let response;
//       if (error.name !== 'ServiceError') {
//         response = responseBuilder.speak("エラーが発生しました。しばらく時間をおいてから再度試してください。").getResponse();
//       } else {
//         console.log('ERROR StatusCode:' + error.statusCode + ' ' + error.message)
//         response = responseBuilder.speak(MESSAGE.permission.retry).getResponse();
//       }
//       return response;
//     }
//
//     // デバイス位置から天気情報を取得
//     const url = `/data/2.5/weather?units=metric&zip=${addressInfo}&APPID=${process.env.WEATHER_APIKEY}`;
//     const weather = await axios.get(url, config);
//     const temperature = Math.floor(weather.data.main.temp);
//
//     // 初回起動
//     if (!attributes.date) {
//       attributes.date = {};
//       greeding = MESSAGE.login.base;
//     } else {
//       const lastUsedDate = attributes.lastUsedDate;
//       const elapsedTimeMs = (date.getTime() - lastUsedDate);
//       if (elapsedTimeMs > 1000 * 60 * 60 * 24 * 14) {
//         greeding = MESSAGE.login.greed;
//       }
//     }
//
//     // ２回目以降の起動
//     // 今の気温が記録済みかどうか判定
//     if (!attributes.date[temperature]) {
//       handlerInput.attributesManager.setSessionAttributes({
//         STATE: STATE.INPUT,
//         today: temperature,
//       });
//
//       speak = greeding.length > 0 ? util.format(MESSAGE.login.speak, greeding) : util.format(MESSAGE.login.speak, "");
//       reprompt = MESSAGE.login.reprompt;
//       handlerInput.responseBuilder
//         .speak(speak)
//         .reprompt(reprompt)
//     } else {
//
//       const memory = attributes.date[temperature].memory;
//       speak = greeding + util.format(MESSAGE.response.speak, temperature, memory);
//       handlerInput.responseBuilder
//         .speak(speak)
//     }
//
//     // 永続化情報の保存
//     attributes.lastUsedDate = date.getTime();
//     handlerInput.attributesManager.setPersistentAttributes(attributes);
//     await handlerInput.attributesManager.savePersistentAttributes();
//
//     return handlerInput.responseBuilder.getResponse();
//   },
// };
//
// /**
//  *
//  */
// const InputRequestHandler = {
//   canHandle(handlerInput: Alexa.HandlerInput) {
//     const attributes = handlerInput.attributesManager.getSessionAttributes();
//     const request = handlerInput.requestEnvelope.request;
//     return request.type === "IntentRequest" && (
//       request.intent.name === "InputIntent"
//     );
//   },
//   async handle(handlerInput: Alexa.HandlerInput) {
//     const {requestEnvelope, serviceClientFactory, responseBuilder} = handlerInput;
//     let attributes = await handlerInput.attributesManager.getPersistentAttributes()
//     const sessionAttributes = handlerInput.attributesManager.getSessionAttributes();
//
//     const consentToken = handlerInput.requestEnvelope.context.System.user.permissions &&
//       handlerInput.requestEnvelope.context.System.user.permissions.consentToken;
//     if (!consentToken) {
//       return responseBuilder
//         .speak(MESSAGE.permission.speak)
//         .withAskForPermissionsConsentCard(PERMISSIONS)
//         .getResponse();
//     }
//
//
//     let temperature = sessionAttributes.today;
//     if (!temperature) {
//       // デバイス位置情報の取得
//       let addressInfo = "";
//       try {
//         const {deviceId} = requestEnvelope.context.System.device;
//         const deviceAddressServiceClient = serviceClientFactory.getDeviceAddressServiceClient();
//         const address = await deviceAddressServiceClient.getCountryAndPostalCode(deviceId);
//         if (address.countryCode === null && address.postalCode === null) {
//           return responseBuilder.speak(MESSAGE.error.noaddress).getResponse();
//         } else {
//           addressInfo = `${address.postalCode},${address.countryCode}`;
//         }
//       } catch (error) {
//         let response;
//         if (error.name !== 'ServiceError') {
//           response = responseBuilder.speak("エラーが発生しました。しばらく時間をおいてから再度試してください。").getResponse();
//         } else {
//           console.log('ERROR StatusCode:' + error.statusCode + ' ' + error.message)
//           response = responseBuilder.speak(MESSAGE.permission.retry).getResponse();
//         }
//         return response;
//       }
//
//       // デバイス位置から天気情報を取得
//       const url = `/data/2.5/weather?units=metric&zip=${addressInfo}&APPID=${process.env.WEATHER_APIKEY}`;
//       const weather = await axios.get(url, config);
//       temperature = Math.floor(weather.data.main.temp);
//     }
//
//
//     const request = handlerInput.requestEnvelope.request as IntentRequest;
//     const slot = request.intent.slots.TempType;
//
//     if (CustomValidator(slot)) {
//       const slotValue = slot.resolutions.resolutionsPerAuthority[0].values[0].value.name;
//
//       attributes.date[temperature] = {
//         memory: slotValue,
//       };
//
//       handlerInput.responseBuilder
//         .speak(util.format(MESSAGE.input.speak, temperature, slotValue))
//
//       // 永続化情報の保存
//       handlerInput.attributesManager.setPersistentAttributes(attributes);
//       await handlerInput.attributesManager.savePersistentAttributes();
//     } else {
//       handlerInput.responseBuilder
//         .speak(MESSAGE.error.speak)
//         .reprompt(MESSAGE.error.reprompt);
//     }
//
//     return handlerInput.responseBuilder.getResponse();
//   },
// };
//
// /**
//  *
//  */
// const HelpHandler = {
//   canHandle(handlerInput: Alexa.HandlerInput) {
//     const request = handlerInput.requestEnvelope.request;
//     return request.type === "IntentRequest" && (
//       request.intent.name === "AMAZON.HelpIntent" ||
//       request.intent.name === "AMAZON.HelpHandler"
//     );
//   },
//   async handle(handlerInput: Alexa.HandlerInput) {
//     const {requestEnvelope, responseBuilder} = handlerInput;
//     const consentToken = handlerInput.requestEnvelope.context.System.user.permissions &&
//       handlerInput.requestEnvelope.context.System.user.permissions.consentToken;
//     if (!consentToken) {
//       return responseBuilder
//         .speak(MESSAGE.permission.speak)
//         .withAskForPermissionsConsentCard(PERMISSIONS)
//         .getResponse();
//     }
//
//     const attributes = await handlerInput.attributesManager.getPersistentAttributes()
//     // 永続化情報の保存
//     attributes.lastUsedDate = new Date().getTime();
//     handlerInput.attributesManager.setPersistentAttributes(attributes);
//
//     handlerInput.attributesManager.setSessionAttributes({
//       STATE: STATE.INPUT,
//     });
//     await handlerInput.attributesManager.savePersistentAttributes();
//
//     return handlerInput.responseBuilder
//       .speak(MESSAGE.help.speak)
//       .reprompt(MESSAGE.help.reprompt)
//       .getResponse();
//   },
// };
//
// /**
//  *
//  */
// const ExitHandler = {
//   canHandle(handlerInput: Alexa.HandlerInput) {
//     const request = handlerInput.requestEnvelope.request;
//     const hasStop = request.type === `IntentRequest` && (
//       request.intent.name === "AMAZON.StopIntent" ||
//       request.intent.name === "AMAZON.CancelIntent"
//     );
//
//     return hasStop;
//   },
//   async handle(handlerInput: Alexa.HandlerInput) {
//     return handlerInput.responseBuilder
//       .speak(MESSAGE.exit.speak)
//       .getResponse();
//   },
// };
//
// /**
//  *
//  */
// const SessionEndedRequestHandler = {
//   canHandle(handlerInput: Alexa.HandlerInput) {
//     console.log("Inside SessionEndedRequestHandler");
//     return handlerInput.requestEnvelope.request.type === "SessionEndedRequest";
//   },
//   async handle(handlerInput: Alexa.HandlerInput) {
//     console.log(`Session ended with reason: ${JSON.stringify(handlerInput.requestEnvelope)}`);
//     return handlerInput.responseBuilder.getResponse();
//   },
// };
//
// /**
//  *
//  */
// const ErrorHandler = {
//   canHandle() {
//     console.log("Inside ErrorHandler");
//     return true;
//   },
//   async handle(handlerInput: Alexa.HandlerInput, error: Error) {
//     console.log(`Error handled: ${JSON.stringify(error)}`);
//     console.log(`Handler Input: ${JSON.stringify(handlerInput)}`);
//
//     const {requestEnvelope, responseBuilder} = handlerInput;
//     const consentToken = handlerInput.requestEnvelope.context.System.user.permissions &&
//       handlerInput.requestEnvelope.context.System.user.permissions.consentToken;
//     if (!consentToken) {
//       return responseBuilder
//         .speak(MESSAGE.permission.speak)
//         .withAskForPermissionsConsentCard(PERMISSIONS)
//         .getResponse();
//     }
//
//     handlerInput.attributesManager.setSessionAttributes({
//       STATE: STATE.INPUT,
//     });
//     await handlerInput.attributesManager.savePersistentAttributes();
//
//     return handlerInput.responseBuilder
//       .speak(MESSAGE.error.speak)
//       .reprompt(MESSAGE.error.reprompt)
//       .getResponse();
//   },
// };
//
// /**
//  *
//  * @param slot
//  * @returns {boolean}
//  */
// const CustomValidator = (slot: any): boolean => {
//   if (slot && slot.resolutions) {
//     return slot.resolutions.resolutionsPerAuthority[0].status.code === ER_SUCCESS_MATCH;
//   } else if (slot && slot.value) {
//     return true;
//   }
//   return false;
// };
//
// // 今後のためにthis.emitWithStateをやりたければ下記の通り。
// // const fooHandler = {
// //   canHandle(input) {
// //   ...
// //   },
// //   handle(input) {
// //   ...
// //   }
// // }
// //
// // const barHandler = {
// //   canHandle(input) {
// //   ...
// //   },
// //   handle(input) {
// //   ...
// //     // call fooHandler
// //     return fooHandler.handle(input);
// //   }
// // }
