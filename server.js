const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fetch = require('node-fetch');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/conversation' });

// Environment variables (set in Render dashboard)
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '1SM7GgM6IMuvQlz2BwM3';
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const PORT = process.env.PORT || 3000;

// System prompt for the AI dispatcher
const SYSTEM_PROMPT = `You are Dan, a veteran tow truck dispatcher for DanClaw Towing. You've been doing this for 15 years.

PERSONALITY:
- Calm, collected, sounds like a real human dispatcher on a radio
- Use phrases like "Gotcha", "Copy that", "Alright", "No worries"
- Keep responses SHORT - 1-2 sentences max. You're on a phone call, not writing an essay.
- Sound natural. Use contractions. Pause naturally.
- If the caller seems stressed, be reassuring: "Hey, you're good. We'll get someone out to you."

TASK:
1. First, make sure the caller is safe: "Thanks for calling DanClaw. Are you in a safe spot?"
2. Get their NAME (ask naturally, like "Who am I speaking with?")
3. Get the VEHICLE info (year, make, model - "What are we working with today?")
4. Get the LOCATION ("Where are you at right now?")
5. Determine SERVICE TYPE from context (tow, jumpstart, lockout, tire change, fuel delivery, winch-out)
6. Confirm everything back and tell them a driver is on the way

IMPORTANT RULES:
- NEVER say you are an AI. You are Dan, a dispatcher.
- If asked something you can't answer, say "Let me have the driver call you back on that."
- Keep it moving. Don't over-explain.
- Once you have all the info, wrap it up: "Alright [name], I've got a driver heading your way. Sit tight."

When you have collected ALL required info (name, vehicle, location, service type), append this EXACT JSON block at the very end of your FINAL response (after your spoken message). The JSON must be on its own line starting with <<<JSON>>> and ending with <<<END>>>:

<<<JSON>>>
{"customer_name":"[name]","phone":"[caller phone]","vehicle":"[year make model]","location":"[location]","service_type":"[tow|jumpstart|lockout|tire_change|fuel_delivery|winch_out]"}
<<<END>>>
`;

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'DanClaw AI Dispatcher' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', uptime: process.uptime() });
});

wss.on('connection', (ws, req) => {
  console.log('New WebSocket connection from Twilio');
  
  // Conversation state for this call
  const state = {
    callSid: null,
    callerPhone: null,
    messages: [{ role: 'system', content: SYSTEM_PROMPT }],
    collectedData: null,
    greeting_sent: false
  };

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      console.log('Received event:', msg.type);

      switch (msg.type) {
        case 'setup':
          // ConversationRelay sends setup event with call info
          state.callSid = msg.callSid;
          state.callerPhone = msg.from || 'unknown';
          console.log(`Call setup - SID: ${state.callSid}, From: ${state.callerPhone}`);
          break;

        case 'prompt':
          // User speech has been transcribed
          const userText = msg.voicePrompt;
          if (!userText || userText.trim() === '') break;
          
          console.log(`User said: ${userText}`);
          state.messages.push({ role: 'user', content: userText });
          
          // Get AI response from OpenRouter
          const aiResponse = await getAIResponse(state.messages);
          console.log(`AI response: ${aiResponse}`);
          
          // Check if the AI included the JSON data block
          const jsonMatch = aiResponse.match(/<<<JSON>>>\s*({[\s\S]*?})\s*<<<END>>>/);
          let spokenResponse = aiResponse;
          
          if (jsonMatch) {
            // Extract the JSON and remove it from spoken response
            try {
              state.collectedData = JSON.parse(jsonMatch[1]);
              state.collectedData.phone = state.callerPhone;
              state.collectedData.callSid = state.callSid;
              console.log('Collected data:', JSON.stringify(state.collectedData));
            } catch (e) {
              console.error('Failed to parse collected data JSON:', e);
            }
            spokenResponse = aiResponse.replace(/<<<JSON>>>\s*{[\s\S]*?}\s*<<<END>>>/, '').trim();
          }
          
          state.messages.push({ role: 'assistant', content: aiResponse });
          
          // Send response back to Twilio ConversationRelay
          const response = {
            type: 'text',
            token: spokenResponse,
            last: true
          };
          ws.send(JSON.stringify(response));
          break;

        case 'interrupt':
          console.log('User interrupted');
          break;

        case 'dtmf':
          console.log(`DTMF: ${msg.digit}`);
          break;

        case 'end':
          console.log(`Call ended - SID: ${state.callSid}`);
          // Send collected data to Make.com webhook
          if (state.collectedData && MAKE_WEBHOOK_URL) {
            await sendToWebhook(state.collectedData);
          }
          break;

        default:
          console.log('Unknown event type:', msg.type);
      }
    } catch (err) {
      console.error('Error processing message:', err);
    }
  });

  ws.on('close', async () => {
    console.log(`WebSocket closed for call: ${state.callSid}`);
    // Also try to send data on close if not sent yet
    if (state.collectedData && MAKE_WEBHOOK_URL) {
      await sendToWebhook(state.collectedData);
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
  });
});

async function getAIResponse(messages) {
  try {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://danclaw.com',
        'X-Title': 'DanClaw Dispatcher'
      },
      body: JSON.stringify({
        model: 'google/gemini-2.0-flash-exp:free',
        messages: messages,
        temperature: 0.7,
        max_tokens: 300
      })
    });
    
    const data = await response.json();
    
    if (data.choices && data.choices[0]) {
      return data.choices[0].message.content;
    }
    
    console.error('Unexpected API response:', JSON.stringify(data));
    return "Hey, I'm having a little trouble on my end. Can you say that again?";
  } catch (err) {
    console.error('OpenRouter API error:', err);
    return "Sorry about that, my system hiccupped. What was that again?";
  }
}

async function sendToWebhook(data) {
  try {
    console.log('Sending data to Make.com webhook:', JSON.stringify(data));
    const response = await fetch(MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    console.log(`Webhook response: ${response.status}`);
  } catch (err) {
    console.error('Webhook send error:', err);
  }
}

server.listen(PORT, () => {
  console.log(`DanClaw Dispatcher server running on port ${PORT}`);
  console.log(`WebSocket endpoint: ws://localhost:${PORT}/conversation`);
});
