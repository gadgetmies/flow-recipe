// language=XML
const xml_data = `<?xml version="1.0" encoding="utf-8" ?>
<recipe>
    <title>Cheese cake</title>
    <ingredients>
        <ingredient id="cookies" name="cookies"/>
        <ingredient id="butter" name="butter"/>
        <ingredient id="gelatin" name="gelatin"/>
        <ingredient id="cold-water" name="cold water"/>
        <ingredient id="cream" name="cream"/>
        <ingredient id="cinnamon" name="cinnamon">
            <properties>
                <property name="type" value="ground"/>
            </properties>
        </ingredient>
        <ingredient id="cinnamon-plum-quark" name="cinnamon plum quark"/>
        <ingredient id="sugar" name="sugar"/>
        <ingredient id="glogg" name="glogg"/>
    </ingredients>
    <tools>
        <tool id="baking-tin" name="baking tin">
            <properties>
                <property name="circumference">
                    <numeric-value number="20" unit="centimeters"/>
                </property>
            </properties>
        </tool>
        <tool id="baking-parchment" name="baking parchment"/>
        <tool id="cling-film" name="cling film"/>
        <tool id="bowl1" name="bowl" />
        <tool id="bowl2" name="bowl" />
        <tool id="bowl3" name="bowl" />
        <tool id="bowl4" name="bowl" />
        <tool id="cup" name="cup" />
        <tool id="plate1" name="plate" />
        <tool id="plate2" name="plate" />
        <tool id="cup2" name="cup" />
        <tool id="cup3" name="cup" />
    </tools>
    <tasks>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="150" unit="grams"/>
                </option>
            </options>
            <inputs>
                <input ref="cookies"/>
            </inputs>
            <outputs>
                <output id="150g-cookies" name="cookies"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="50" unit="grams"/>
                </option>
            </options>
            <inputs>
                <input ref="butter"/>
                <input ref="cup"/>
            </inputs>
            <outputs>
                <output id="50g-butter" name="butter"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="4" unit="sheets"/>
                </option>
            </options>
            <inputs>
                <input ref="gelatin"/>
            </inputs>
            <outputs>
                <output id="gelatin-for-filling" name="gelatin"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="2" unit="deciliters"/>
                </option>
            </options>
            <inputs>
                <input ref="cold-water"/>
                <input ref="plate1"/>
            </inputs>
            <outputs>
                <output id="cold-water-for-soaking1" name="cold water"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="1" unit="sheets"/>
                </option>
            </options>
            <inputs>
                <input ref="gelatin"/>
            </inputs>
            <outputs>
                <output id="gelatin-for-glaze" name="gelatin for glaze"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="2" unit="deciliters"/>
                </option>
            </options>
            <inputs>
                <input ref="cream"/>
                <input ref="bowl2"/>
            </inputs>
            <outputs>
                <output id="2dl-cream" name="cream"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="1" unit="teaspoons"/>
                </option>
            </options>
            <inputs>
                <input ref="cinnamon"/>
                <!-- TODO: having to specify the target is probelmatic as it will fix the order the ingredients are measured and mixed.
                 Would be better to combine the measure and mix -->
                <input ref="whipped-cream"/>
            </inputs>
            <outputs>
                <output id="whipped-cream+cinnamon" name="whipped cream and cinnamon"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="2" unit="tablespoons"/>
                </option>
            </options>
            <inputs>
                <input ref="glogg"/>
                <input ref="cup2"/>
            </inputs>
            <outputs>
                <output id="glogg-for-filling" name="glogg"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="2.5" unit="deciliters"/>
                </option>
            </options>
            <inputs>
                <input ref="glogg"/>
                <input ref="bowl4"/>
            </inputs>
            <outputs>
                <output id="cold-glogg-for-glaze" name="cold glogg"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="0.5" unit="deciliters"/>
                </option>
            </options>
            <inputs>
                <input ref="glogg"/>
                <input ref="cup3"/>
            </inputs>
            <outputs>
                <output id="glogg-to-be-heated-for-glaze" name="glogg"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="3" unit="sheets"/>
                </option>
            </options>
            <inputs>
                <input ref="gelatin"/>
            </inputs>
            <outputs>
                <output id="gelatin-for-glaze" name="gelatin for glaze"/>
            </outputs>
        </task>
        <task operation="melt">
            <inputs>
                <input ref="50g-butter"/>
            </inputs>
            <outputs>
                <output id="melted-butter" name="melted butter"/>
            </outputs>
        </task>
        <join>
            <task operation="crumble">
                <inputs>
                    <input ref="150g-cookies"/>
                </inputs>
                <outputs>
                    <output id="crumbled-cookies" name="crumbled cookies"/>
                </outputs>
            </task>
            <task operation="incorporate">
                <inputs>
                    <input ref="melted-butter"/>
                    <input ref="crumbled-cookies"/>
                </inputs>
                <outputs>
                    <output id="butter+cookies" name="butter and cookies"/>
                </outputs>
            </task>
        </join>
        <task operation="line">
            <inputs>
                <input ref="baking-tin"/>
                <input ref="baking-parchment"/>
            </inputs>
            <outputs>
                <output id="lined-tin" name="lined baking tin"/>
            </outputs>
        </task>
        <task operation="press">
            <inputs>
                <input ref="lined-tin"/>
                <input ref="butter+cookies"/>
            </inputs>
            <outputs>
                <output id="butter+cookies-in-tin" name="butter and cookies in tin"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="2" unit="deciliters"/>
                </option>
            </options>
            <inputs>
                <input ref="cold-water"/>
                <input ref="plate2"/>
            </inputs>
            <outputs>
                <output id="cold-water-for-soaking2" name="cold water"/>
            </outputs>
        </task>
        <task operation="soak">
            <inputs>
                <input ref="gelatin-for-filling"/>
                <input ref="cold-water-for-soaking1"/>
            </inputs>
            <outputs>
                <output id="soaked-gelatin-for-filling" name="soaked gelatin"/>
            </outputs>
        </task>
        <task operation="soak">
            <inputs>
                <input ref="gelatin-for-glaze"/>
                <input ref="cold-water-for-soaking2"/>
            </inputs>
            <outputs>
                <output id="soaked-gelatin-for-glaze" name="soaked gelatin for glaze"/>
            </outputs>
        </task>
        <task operation="whip">
            <inputs>
                <input ref="2dl-cream"/>
            </inputs>
            <outputs>
                <output id="whipped-cream" name="whipped cream"/>
            </outputs>
        </task>
        <task operation="mix">
            <inputs>
                <input ref="whipped-cream+cinnamon"/>
            </inputs>
            <outputs>
                <output id="cinnamon-whipped-cream" name="cream with cinnamon"/>
            </outputs>
        </task>
        <task operation="boil">
            <inputs>
                <input ref="glogg-for-filling"/>
            </inputs>
            <outputs>
                <output id="boiling-glogg-for-filling" name="boiling glogg"/>
            </outputs>
        </task>
        <task operation="mix">
            <inputs>
                <input ref="boiling-glogg-for-filling"/>
                <input ref="soaked-gelatin-for-filling"/>
            </inputs>
            <outputs>
                <output id="glogg-with-gelatin-for-filling" name="glogg with gelatin"/>
            </outputs>
        </task>
        <task operation="chill">
            <options>
                <option name="duration">
                    <numeric-value number="3" unit="minutes"/>
                </option>
            </options>
            <inputs>
                <input ref="glogg-with-gelatin-for-filling"/>
            </inputs>
            <outputs>
                <output id="cooled-glogg-with-gelatin-for-filling" name="cooled glogg"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="400" unit="grams"/>
                </option>
            </options>
            <inputs>
                <input ref="cinnamon-plum-quark"/>
                <input ref="bowl3"/>
            </inputs>
            <outputs>
                <output id="400g-quark" name="quark"/>
            </outputs>
        </task>
        <task operation="measure">
            <options>
                <option name="amount">
                    <numeric-value number="3" unit="tablespoons"/>
                </option>
            </options>
            <inputs>
                <input ref="sugar"/>
                <input ref="400g-quark"/>
            </inputs>
            <outputs>
                <output id="quark+sugar" name="quark and sugar"/>
            </outputs>
        </task>
        <task operation="mix">
            <inputs>
                <input ref="quark+sugar"/>
                <input ref="cooled-glogg-with-gelatin-for-filling"/>
            </inputs>
            <outputs>
                <output id="glogg-and-quark" name="glogg and quark"/>
            </outputs>
        </task>
        <task operation="fold">
            <inputs>
                <input ref="glogg-and-quark"/>
                <input ref="cinnamon-whipped-cream"/>
            </inputs>
            <outputs>
                <output id="filling" name="filling"/>
            </outputs>
        </task>
        <task operation="add-on-top">
            <inputs>
                <input ref="butter+cookies-in-tin"/>
                <input ref="filling"/>
            </inputs>
            <outputs>
                <output id="cake" name="cake"/>
            </outputs>
        </task>
        <task operation="level">
            <inputs>
                <input ref="cake"/>
            </inputs>
            <outputs>
                <output id="leveled-cake" name="cake"/>
            </outputs>
        </task>
        <task operation="cover">
            <inputs>
                <input ref="cling-film"/>
                <input ref="leveled-cake"/>
            </inputs>
            <outputs>
                <output id="covered-cake" name="covered-cake"/>
            </outputs>
        </task>
        <task operation="chill">
            <options>
                <option name="duration">
                    <numeric-value number="4" unit="hours"/>
                </option>
            </options>
            <inputs>
                <input ref="covered-cake"/>
            </inputs>
            <outputs>
                <output id="chilled-cake" name="chilled cake"/>
            </outputs>
        </task>
        <task operation="soak">
            <inputs>
                <input ref="gelatin-for-glaze"/>
            </inputs>
            <outputs>
                <output id="soaked-gelatin-for-glaze" name="soaked gelatin"/>
            </outputs>
        </task>
        <task operation="boil">
            <inputs>
                <input ref="glogg-to-be-heated-for-glaze"/>
            </inputs>
            <outputs>
                <output id="boiling-glogg-for-glaze" name="boiling glogg"/>
            </outputs>
        </task>
        <task operation="mix">
            <inputs>
                <input ref="boiling-glogg-for-glaze"/>
                <input ref="soaked-gelatin-for-glaze"/>
            </inputs>
            <outputs>
                <output id="glogg-with-gelatin-for-glaze" name="glogg with gelatin"/>
            </outputs>
        </task>
        <task operation="mix">
            <inputs>
                <input ref="glogg-with-gelatin-for-glaze"/>
                <input ref="cold-glogg-for-glaze"/>
            </inputs>
            <outputs>
                <output id="glaze" name="glaze"/>
            </outputs>
        </task>
        <task operation="spoon">
            <inputs>
                <input ref="chilled-cake"/>
                <input ref="glaze"/>
            </inputs>
            <outputs>
                <output id="glazed-cake" name="glazed cake"/>
            </outputs>
        </task>
        <task operation="chill">
            <options>
                <option name="duration">
                    <numeric-value number="1" unit="hours"/>
                </option>
            </options>
            <inputs>
                <input ref="glazed-cake"/>
            </inputs>
            <outputs>
                <output id="finished-cake"/>
            </outputs>
        </task>
    </tasks>
</recipe>`;

export default xml_data;
