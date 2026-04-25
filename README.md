# ATS Resume Matcher for LinkedIn

**Instantly see how well your resume matches any LinkedIn job posting.**

---

### The Story: Why We Built This
We've all been there—spending hours scrolling through LinkedIn, finding the "perfect" job, and then wondering if our resume will even make it past the initial Applicant Tracking System (ATS) filters. Tailoring your resume for every single application is exhausting and time-consuming.

The **ATS Resume Matcher** was built to take the guesswork out of job hunting. By leveraging the power of **Gemini 1.5 Flash AI**, it acts as your personal career coach. It scans job descriptions in real-time and compares them to your skills, giving you an instant match score and a clear list of exactly what keywords you're missing. It’s about working smarter, not harder, to get your foot in the door.

---

### Key Features
- **AI-Powered Matching:** Uses Google's Gemini 1.5 Flash to analyze complex job descriptions and resumes.
- **Instant Match Score:** Get a weighted percentage score based on required and preferred skills.
- **Skill Gap Analysis:** Specifically identifies missing "must-have" and "nice-to-have" keywords.
- **Resume Optimization Tips:** Provides actionable suggestions to push your score above the 85% threshold.
- **Privacy First:** Your resume data is processed in-memory and stored only on your local device. We don't store your job descriptions or personal files on any server.
- **Multi-Format Support:** Handles both **PDF** and **DOCX** resumes.

---

### How to Install

1.  **Download/Clone the Repo:**
    Download this repository as a ZIP file and extract it, or clone it using:
    ```bash
    git clone https://github.com/your-repo/ats-matcher-extension.git
    ```
2.  **Open Chrome Extensions:**
    In your Chrome browser, go to `chrome://extensions/`.
3.  **Enable Developer Mode:**
    Toggle the **"Developer mode"** switch in the top right corner.
4.  **Load the Extension:**
    Click the **"Load unpacked"** button and select the `ats-matcher-extension` folder (the one containing `manifest.json`).
5.  **Get Your API Key:**
    Visit [Google AI Studio](https://aistudio.google.com/app/apikey) to generate a free Gemini API key.

---

### How to Use

1.  **Set Up:** Click the extension icon in your toolbar. Follow the onboarding flow to enter your **Gemini API Key**.
2.  **Upload Resume:** Upload your resume in PDF or DOCX format. The AI will extract your core skills and keywords.
3.  **Browse LinkedIn:** Go to any job posting on [LinkedIn Jobs](https://www.linkedin.com/jobs/).
4.  **Analyze:** The extension will automatically detect the job description. Click the floating "Match" button or open the extension popup to see your match results and missing keywords.

---

### License & Terms

**Free to Use & Modify**
This project is provided "as-is" without any warranty of any kind. You are free to use, modify, and distribute this software for personal or commercial purposes.

**Non-Liability**
The author(s) shall not be liable for any claims, damages, or other liability, whether in an action of contract, tort, or otherwise, arising from, out of, or in connection with the software or the use or other dealings in the software. This tool is intended for assistance only and does not guarantee job interviews or placement.

---

*Built with ❤️ for job seekers.*
